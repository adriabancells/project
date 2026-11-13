# Piano AR

Web app que fa servir **WebXR** per col·locar un piano virtual (2 octaves, mida real) sobre una taula i tocar-lo en realitat augmentada.

## Funcionalitats

- **Detecció de superfícies** (WebXR *hit-test*): apunta a la taula i toca per col·locar-hi el piano, orientat cap a tu.
- **Tocar amb el dit a la pantalla** (mòbil Android): multitàctil, acords i glissandos arrossegant el dit.
- **Tocar amb les mans** (Meta Quest i altres ulleres amb *hand-tracking*): les puntes dels 5 dits de cada mà premen les tecles; la velocitat de baixada del dit controla la intensitat. Com que el piano està sobre la taula real, notes el "tacte" de la superfície.
- **So sintetitzat** amb Web Audio (parcials inharmònics, cop de martell, reverb), sense fitxers d'àudio.
- Canvi d'octava (Do1–Do8), 3 mides de piano (×1, ×1.5, ×2) i botó per recol·locar.
- **Mode 3D sense AR** per provar-ho a l'ordinador: ratolí/tàctil i teclat (`A W S E D F T G Y H U J K O L P`, `Z`/`X` per canviar d'octava).

## Compatibilitat

| Dispositiu | AR | Com es toca |
|---|---|---|
| Android + Chrome (amb Google Play Services for AR) | ✅ | Tocant la pantalla |
| Meta Quest (navegador Meta) | ✅ | Amb les mans o els comandaments |
| iPhone / iPad (Safari) | ❌ (Apple no suporta WebXR AR) | Mode 3D |
| Ordinador | ❌ | Mode 3D |

## Executar-ho

No cal compilar res: són fitxers estàtics (`index.html`, `main.js`, `style.css`) i Three.js es carrega des d'un CDN.

```bash
npx serve .          # o: python3 -m http.server 8000
```

WebXR **requereix HTTPS** (o `localhost`). Per provar-ho al mòbil:

- Publica el repositori a **GitHub Pages** (Settings → Pages → branca), o
- Connecta el mòbil per USB i fes servir `chrome://inspect` → *Port forwarding* (8000 → localhost:8000), o
- Fes servir un túnel HTTPS (p. ex. `npx localtunnel --port 8000`).
