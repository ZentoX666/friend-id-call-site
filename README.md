# Friend ID Call (demo)

Site simplu cu:
- signup/login/logout cu **email + parolă**
- ID numeric unic (5–9 cifre) afișat când apeși pe avatar
- adăugare prieteni prin ID (mutual)
- apel audio simplu între prieteni (WebRTC + Socket.IO)

## Pornire

1) În folderul proiectului, copiază `.env.example` în `.env` și schimbă `SESSION_SECRET`.

2) Instalează dependențele:

```bash
npm install
```

3) Pornește serverul:

```bash
npm run dev
```

4) Deschide în browser:
- `http://localhost:3000`

## Pornire automată (fără start manual) pe Windows

### Opțiunea 1: PM2 (ușor)

1) Instalează PM2 global:

```bash
npm i -g pm2
```

2) Pornește aplicația:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

3) Ca să pornească la restart de Windows, rulează (în PowerShell ca Administrator):

```bash
pm2 startup
```

PM2 îți va afișa o comandă “pm2 startup ...” — ruleaz-o exact cum apare.

### Opțiunea 2: Task Scheduler (fără PM2)
- Creezi un task care rulează `node server.js` la logon/startup (îți pot da pașii exact dacă vrei varianta asta).

## Notițe
- Baza de date e în fișierul `data.sqlite` (se creează automat).
- Pentru apel, trebuie permis microfonul în browser.
- Pentru test rapid: deschide două browsere diferite (ex: Chrome + Edge), creează două conturi, adaugă prieten prin ID și apasă „Sună”.

## Publicare pe Netlify (important)

Netlify găzduiește în principal **site-uri statice**. Asta înseamnă:
- UI-ul din `public/` poate fi publicat pe Netlify.
- Dar serverul Node (`server.js`), login/prieteni și mai ales apelurile (Socket.IO/WebRTC signaling) **nu pot rula pe Netlify** ca server normal (Netlify Functions nu suportă WebSockets persistent).

Recomandarea practică:
- **Frontend (UI)**: Netlify
- **Backend (Node + Socket.IO + DB)**: Render / Fly.io / Railway / un VPS

Dacă îmi spui ce alegi pentru backend (Render/Fly/Railway), îți pregătesc configurația exactă + pașii de deploy.

## Deploy Render + Netlify (recomandat, free)

### A) Render (backend)
1) Pui proiectul pe GitHub (tot folderul `friend-id-call-site`).
2) În Render: **New → Web Service → conectezi repo-ul**.
3) Setări:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4) Environment:
   - `SESSION_SECRET` = un string lung/random (obligatoriu)
   - `PORT` = nu seta manual (Render îl dă automat)
5) După deploy, copiezi URL-ul backend-ului (ex: `https://numele-tau.onrender.com`).

### B) Netlify (frontend)
1) În Netlify: **Add new site → Import from Git** (sau drag & drop dacă vrei).
2) Setări:
   - **Base directory**: gol
   - **Build command**: gol
   - **Publish directory**: `public`
3) În `public/_redirects`, înlocuiești `https://RENDER_BACKEND_URL` cu URL-ul tău de Render, de ex:

```
/api/*  https://numele-tau.onrender.com/api/:splat  200
/socket.io/*  https://numele-tau.onrender.com/socket.io/:splat  200
/*  /index.html  200
```

4) Redeploy pe Netlify.

Acum site-ul Netlify va folosi backend-ul Render prin proxy și îți merg:
- login/signup/logout (cookies pe domeniul Netlify)
- prieteni
- apel (Socket.IO/WebSocket)

