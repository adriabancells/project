// Síntesi de piano amb Web Audio (sense mostres externes)
export class PianoSynth {
  constructor() {
    this.ctx = null;
    this.voices = new Map();
  }

  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(comp);

      // Reverb curta generada
      const reverb = ctx.createConvolver();
      reverb.buffer = this.makeImpulse(2.2, 3);
      const wet = ctx.createGain();
      wet.gain.value = 0.18;
      this.master.connect(reverb);
      reverb.connect(wet);
      wet.connect(comp);

      // Soroll per a l'impacte del martell
      const len = Math.floor(ctx.sampleRate * 0.05);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  noteOn(midi, velocity = 0.8) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.kill(midi, t);

    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const vel = Math.min(1, Math.max(0.15, velocity));

    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.master);

    // Filtre que s'enfosqueix amb el temps (com una corda real)
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.5;
    tone.frequency.setValueAtTime(Math.min(18000, f * (4 + vel * 10)), t);
    tone.frequency.exponentialRampToValueAtTime(Math.min(18000, Math.max(f * 1.5, 300)), t + 1.5);
    tone.connect(out);

    const sustain = Math.min(6, Math.max(0.8, 4.5 * Math.pow(261.6 / f, 0.55)));
    const partials = [1, 0.55, 0.32, 0.2, 0.12, 0.08, 0.05];
    const B = 0.0004; // inharmonicitat
    const amp0 = 0.2 * vel;
    const oscs = [];

    partials.forEach((a, i) => {
      const n = i + 1;
      const pf = f * n * Math.sqrt(1 + B * n * n);
      if (pf > ctx.sampleRate / 2 - 1000) return;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = pf;
      o.detune.value = (Math.random() - 0.5) * 3;
      const g = ctx.createGain();
      const peak = amp0 * a;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.004);
      g.gain.setTargetAtTime(peak * 0.4, t + 0.004, 0.07);
      g.gain.setTargetAtTime(0.0001, t + 0.15, sustain / (4 * (1 + 0.5 * (n - 1))));
      o.connect(g);
      g.connect(tone);
      o.start(t);
      oscs.push(o);
    });

    // Cop del martell
    const ns = ctx.createBufferSource();
    ns.buffer = this.noise;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = Math.min(8000, f * 3);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.05 * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    ns.connect(nf);
    nf.connect(ng);
    ng.connect(out);
    ns.start(t);
    ns.stop(t + 0.05);

    const end = t + sustain * 1.6 + 0.5;
    oscs.forEach((o) => o.stop(end));
    const voice = { out, oscs };
    oscs[0].onended = () => {
      out.disconnect();
      if (this.voices.get(midi) === voice) this.voices.delete(midi);
    };
    this.voices.set(midi, voice);
  }

  noteOff(midi) {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;
    this.release(v, this.ctx.currentTime, 0.12);
  }

  release(v, t, tc) {
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.setTargetAtTime(0, t, tc);
    const stopAt = t + tc * 8;
    v.oscs.forEach((o) => { try { o.stop(stopAt); } catch { /* ja aturat */ } });
  }

  kill(midi, t) {
    const v = this.voices.get(midi);
    if (v) {
      this.release(v, t, 0.015);
      this.voices.delete(midi);
    }
  }
}
