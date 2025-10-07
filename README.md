
# Bingo Admin Web — Guía Rápida

## Requisitos
- Node.js 18+ y npm

## Instalación
```bash
cd bingo-admin-web
npm install
cp .env.example .env
# Edita ADMIN_PASSWORD y JWT_SECRET en .env
```

## Ejecutar en local
```bash
npm start
```
Abre:
- Sala pública: http://localhost:3000
- Admin: http://localhost:3000/admin.html

## Uso básico (Admin)
1. Entra con tu contraseña.
2. Configura el rango (1–5 / 1–10 / 1–20) y "veces para ganar".
3. Para forzar ganadores, en "Programar próximas bolas" agrega números separados por coma.
4. Puedes reiniciar la ronda cuando quieras.
