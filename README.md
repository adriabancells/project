# Sintetitzador AR

Instrument electrònic que es toca **movent les mans a l'aire davant la càmera** (qualsevol mòbil o ordinador amb càmera). El so es visualitza com a ones de neó que vibren entre els dits.

## Com es toca

| Mà | Moviment | Efecte |
|---|---|---|
| **Esquerra · acords** | Amunt / avall | Canvia d'acord dins la progressió de l'escala |
| | Separar cada dit del polze | Fa sonar cada nota de l'acord (índex = fonamental, cor = 3a, anular = 5a, petit = 7a) |
| | Esquerra / dreta | Brillantor del pad |
| **Dreta · melodia** | Amunt / avall | Nota (pentatònica de 2 octaves, amb lliscament) |
| | Obrir polze-índex | Volum |
| | Esquerra / dreta | Filtre (fosc → brillant) |
| | Obrir tots els dits | Eco i ressonància |

Tot està quantitzat a l'escala triada (La menor, Do major, Re dòrica, Fa lidi), de manera que sempre sona harmònic. Hi ha tres sons: *Supersaw*, *Vidre* i *Analògic*.

**Visuals:** vídeo enfosquit, cordes de neó amb lluentor i rastre entre polze i dits (acords), l'ona real del so entre els dits (melodia), oscil·loscopi circular al palmell, partícules, ones expansives en canviar de nota/acord i espectre de freqüències.

Fitxers: `index.html` + `sinte.js`. Es carrega MediaPipe Hands des de CDN.

---

# Gos de festa (`gos.html`)

Apunta la càmera a un gos: el detecta (MediaPipe Object Detector, categoria *dog*), li posa un **barret de festa** i **ulleres de sol**, i genera música electrònica alegre (Do–Lam–Fa–Sol) que segueix el seu moviment:

- **Energia del moviment** → tempo (92–142 BPM) i instruments: pad i baix quan està quiet; caixa, charles i melodia més densa quan es mou.
- **Alçada del cap** → notes de la melodia, tocada amb un so sintetitzat de "bup!" de gos (sempre dins l'escala pentatònica, i als temps forts nota de l'acord).
- **Salt** → "boing!" i explosió de confeti. Quan apareix el gos sona una fanfàrria.
- El barret bota al ritme; surten notes ♪ del cap.
- Botons: 📸 foto (compartir/descarregar), mida dels accessoris, cap auto/manual, música on/off, càmera.

Limitació: no hi ha cap model públic al navegador amb punts de la cara dels gossos, així que la posició del cap s'estima a partir de la silueta. Si no encaixa, **toca el cap del gos** i els accessoris s'hi queden enganxats.

---

# Piano AR (`piano.html`)

Web app que fa servir **WebXR** per col·locar un piano virtual (2 octaves, mida real) sobre una taula i tocar-lo en realitat augmentada.

## Funcionalitats

- **Detecció de superfícies** (WebXR *hit-test*): apunta a la taula i toca per col·locar-hi el piano, orientat cap a tu.
- **Tocar amb el dit a la pantalla** (mòbil Android): multitàctil, acords i glissandos arrossegant el dit.
- **Tocar amb les mans** (Meta Quest i altres ulleres amb *hand-tracking*): les puntes dels 5 dits de cada mà premen les tecles; la velocitat de baixada del dit controla la intensitat. Com que el piano està sobre la taula real, notes el "tacte" de la superfície.
- **Piano a la taula amb la càmera** (`mans.html`, qualsevol mòbil, també iPhone): el mòbil, dret sobre la taula i mirant-te, detecta les mans amb MediaPipe. Una tecla sona quan piques la taula amb la punta del dit a sobre (es detecta la baixada ràpida del dit i l'aturada en tocar la taula). Arrossegant les 4 cantonades ajustes on queda el piano; es desa per a la propera vegada.
- **So sintetitzat** amb Web Audio (parcials inharmònics, cop de martell, reverb), sense fitxers d'àudio.
- Canvi d'octava (Do1–Do8), 3 mides de piano (×1, ×1.5, ×2) i botó per recol·locar.
- **Mode 3D sense AR** per provar-ho a l'ordinador: ratolí/tàctil i teclat (`A W S E D F T G Y H U J K O L P`, `Z`/`X` per canviar d'octava).

## Compatibilitat

| Dispositiu | AR | Com es toca |
|---|---|---|
| Android + Chrome (amb Google Play Services for AR) | ✅ | Tocant la pantalla, o picant la taula (mode càmera) |
| Meta Quest (navegador Meta) | ✅ | Amb les mans o els comandaments |
| iPhone / iPad (Safari) | ❌ WebXR · ✅ mode càmera | Picant la taula (mode càmera) o mode 3D |
| Ordinador | ❌ | Mode 3D |

## Executar-ho

No cal compilar res: són fitxers estàtics (`index.html`/`main.js` per al mode WebXR, `mans.html`/`mans.js` per al mode càmera, `synth.js` per al so i `style.css`). Three.js i MediaPipe es carreguen des de CDN.

### Consells per al mode càmera
- Mòbil en horitzontal, recolzat dret a 40–50 cm, amb bona llum.
- Pica amb decisió i deixa el dit quiet un instant sobre la taula; aixeca'l per acabar la nota.
- Si salten notes soles, baixa la **Sensibilitat**; si en costa que sonin, puja-la.

```bash
npx serve .          # o: python3 -m http.server 8000
```

WebXR **requereix HTTPS** (o `localhost`). Per provar-ho al mòbil:

- Publica el repositori a **GitHub Pages** (Settings → Pages → branca), o
- Connecta el mòbil per USB i fes servir `chrome://inspect` → *Port forwarding* (8000 → localhost:8000), o
- Fes servir un túnel HTTPS (p. ex. `npx localtunnel --port 8000`).
