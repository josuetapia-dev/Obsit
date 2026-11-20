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
node src/cerebro/pack.js C:\dev\gaya\gaya-vainilla
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
- `src/cerebro/brain.js` — busca Claude Code y le pide la explicación (solo herramientas de lectura: Read, Grep, Glob).
- `src/renderer/robot.js` — el robot en 3D (Three.js).
- `src/renderer/bubble.html` — el globo de texto.
- Variables opcionales: `OBSI_MODEL` (modelo, por defecto `sonnet`), `OBSI_CLAUDE` (ruta a `claude.exe`).

## Voz: "Oye Obsi"

Obsi-boty habla con las voces de Windows (Raúl o Sabina) y te escucha con **Vosk**, un reconocedor de voz en español que corre en tu compu: el audio nunca sale de ella.

| Quieres | Haz esto |
|---|---|
| Que te escuche siempre | Clic derecho → **Escuchar «Oye Obsi»**. La primera vez descarga el modelo de voz (~40 MB, una sola vez) |
| Hablarle sin decir "Oye Obsi" | Botón 🎤 del chat, o `Ctrl+Alt+Espacio` desde cualquier lugar |
| Simulacro de defensa hablado | Clic derecho → **Simulacro de defensa oral**: pregunta en voz alta y escucha tu respuesta |
| Que deje de hablar | Di "Oye Obsi, cállate", escribe algo o apaga **Hablar en voz alta** |
| Que te espere al prender la compu | Clic derecho → **Esperarme al prender la compu**. Al encender, Obsi no se abre: queda un "guardia" mínimo (~110 MB, con el ícono junto al reloj). Di **"Obsi, a trabajar"** y aparece |
| Esconderlo sin cerrar el oído | Di **"Oye Obsi, ya terminamos"** o clic derecho → **Esconderme**: Obsi se cierra por completo y el guardia sigue esperando |

Comandos rápidos por voz: "Obsi, a trabajar" (despertarlo), "ya terminamos" (esconderlo), "dame el tour", "simulacro", "explícame este archivo", "siguiente" / "anterior" (en el tour), "hazme una pregunta", "reto", "cállate", "duérmete". Todo lo demás se lo pregunta a Claude (o busca en el paquete en modo estudio).

Si no te escucha: revisa en Windows **Configuración → Privacidad → Micrófono** que las apps de escritorio puedan usarlo.

El guardia usa el reconocedor de voz que trae Windows (en inglés), así que entiende "Obsi, a trabajar" y "Oye Obsi" escritos como los pronunciaría un angloparlante. Para apagarlo: clic derecho en su ícono junto al reloj → **Dejar de escuchar**.
