# Obsi-boty

Mascota de escritorio del equipo **Obsi**. Vive en una esquina de la pantalla y, cuando le das clic con un archivo abierto en VS Code, te explica en pocas palabras qué hace ese archivo (usando Claude Code y la documentación de `docs/` del proyecto).

## Abrirlo

La primera vez, crea el acceso directo (Escritorio y menú Inicio, con el ícono del robot):

```powershell
cd C:\dev\JOPE-AR\obsi-boty
npm run acceso-directo
```

Después, ábrelo con doble clic en **Obsi-boty** en tu escritorio o búscalo en el menú Inicio. También puedes usar `npm start` desde esta carpeta.

## Usarlo

| Acción | Qué pasa |
|---|---|
| Abrir un archivo en VS Code | Obsi-boty se asoma con curiosidad |
| Clic sobre el robot | Lee el archivo abierto y te lo explica en un globo |
| `Ctrl+Alt+O` dentro de VS Code | Lo mismo, sin tocar el robot |
| Escribir en el chat | Pregúntale lo que quieras del proyecto; recuerda la conversación |
| "Muéstrame el controlador que…" | Lo encuentra y lo abre en VS Code en la línea exacta |
| Rutas en `código` dentro del chat | Clic para abrir ese archivo en VS Code |
| "Hazme una pregunta de examen" | Te pregunta como un profesor y califica tu respuesta (celebra si aciertas) |
| Reto "muéstrame" | Obsi-boty describe un archivo sin decir su nombre; tú lo abres en VS Code y él detecta si acertaste (con pistas y opción de rendirte) |
| Preguntas sorpresa | Cada ~25 min, si estás activo, te ofrece una pregunta (se apaga en el menú) |
| ↺ en el chat | Empieza una conversación nueva |
| Clic otra vez / botón × / Esc | Cierra el chat |
| Arrastrar | Lo mueves a donde quieras (recuerda la posición) |
| Clic derecho | Menú: explicar, saludar, dormir, tamaño, volver a la esquina, salir |

Las explicaciones se guardan: si el archivo no cambia, la segunda vez responde al instante (dice "guardado").

## Modo estudio (sin Claude Code, gratis)

Si no tienes Claude Code (plan gratuito), Obsi-boty funciona en **modo estudio** con el paquete que está en `paquetes/<proyecto>.json`:

| Funciona | Cómo |
|---|---|
| Tour del proyecto | Completo, igual que con Claude |
| Explicar archivos | Los ~33 archivos más importantes, al instante |
| Preguntas de examen | Banco de preguntas; escribes tu respuesta, ves la correcta y te calificas |
| Retos "muéstrame" | Completos, con pistas y detección del archivo que abres |
| Chat libre | No; busca en el paquete y te sugiere archivos relacionados |

**Para actualizar el paquete** (quien tenga Claude Code): clic derecho en el robot → **Generar paquete de estudio**, o desde la terminal:

```powershell
cd C:\dev\JOPE-AR\obsi-boty
node src/pack.js C:\dev\gaya\gaya-vainilla
```

Tarda unos 2 minutos. Luego commit + push, y el equipo hace `git pull`.

## Primera vez: iniciar sesión en Claude Code

Obsi-boty usa Claude Code en modo automático (`claude -p`) con **tu suscripción**. Fuera de la app de escritorio hay que iniciar sesión una vez:

1. Instala Claude Code como comando (si aún no lo tienes):
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```
2. Abre una terminal nueva, ejecuta `claude` y escribe `/login`. Se abre el navegador para que entres con tu cuenta.
3. Listo. Sal con `/exit` y dale clic a Obsi-boty.

## Extensión de VS Code

Está en `vscode-extension/`. Para reinstalarla (por ejemplo en la computadora de un compañero):

```powershell
code --install-extension C:\dev\JOPE-AR\obsi-boty\vscode-extension\obsi-boty-vscode.vsix
```

Solo envía la ruta del archivo abierto a `127.0.0.1:47321` (tu propia computadora).

## Cómo está hecho

- `src/main.js` — ventana transparente, servidor local para VS Code, globo de texto, menú.
- `src/brain.js` — busca Claude Code y le pide la explicación (solo herramientas de lectura: Read, Grep, Glob).
- `src/renderer/robot.js` — el robot en 3D (Three.js).
- `src/renderer/bubble.html` — el globo de texto.
- Variables opcionales: `OBSI_MODEL` (modelo, por defecto `sonnet`), `OBSI_CLAUDE` (ruta a `claude.exe`).
