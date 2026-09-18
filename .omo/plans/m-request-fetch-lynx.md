# Plan — `m.request` para mithril-lynx-v2: ¿alcanza el `fetch` de Lynx?

> Estado: **INVESTIGACIÓN COMPLETA, veredicto emitido — implementación NO
> iniciada.** Idioma: español. Insumo de las 2 tareas solicitadas: (1)
> cómo se hace fetch en Lynx, (2) si el `fetch` de Lynx cumple lo que
> `m.request` (spec: <https://mithril.js.org/request.html>) espera.
> Fuentes: doc oficial de Mithril, doc oficial de Lynx
> (`lynxjs.org/api/lynx-api/global/fetch.html`), **los `.d.ts` reales
> instalados** de `@lynx-js/types` (evidencia de tipos, no solo prosa de
> doc), y el código fuente real de `m.request`
> (`node_modules/mithril/request/request.js`, 199 líneas).

---

## Veredicto (primero, para no enterrarlo)

**Gap grande, pero no total.** Hay un subconjunto real y útil de
`m.request` (GET/POST con JSON, params en la URL, headers, `deserialize`/
`extract`/`type`, el flag `background`, y la forma del error) que **sí se
puede replicar fielmente** sobre el `fetch` de Lynx. Pero varias opciones
de `m.request` dependen de mecanismos que **no existen en absoluto** en
Lynx — no es "distinto nombre, mismo poder", es **ausencia real** en el
propio archivo de tipos oficial (`@lynx-js/types`), no solo en la prosa de
la doc:

- `config(xhr) => xhr` (el escape hatch de la API real) — no tiene
  traducción posible: `fetch` no expone un objeto vivo para mutar a mitad
  de vuelo.
- Cancelación (`xhr.abort()`) — `RequestInit` de Lynx no tiene campo
  `signal`, y **no existe `AbortController`/`AbortSignal` en
  `@lynx-js/types`, en ningún lado**.
- `FormData`/`URLSearchParams` como body — la doc de Lynx dice
  explícitamente que no están soportados.
- `responseType: "blob"` — `Body` en Lynx solo tiene `arrayBuffer()`,
  `json()`, `text()`. Sin `.blob()`.
- `timeout` nativo — sin campo en `RequestInit`, y sin `AbortController`
  para implementarlo bien tampoco (ver §4).
- `withCredentials`, `user`/`password` (auth básica vía `xhr.open`),
  `async: false` (modo síncrono) — conceptos exclusivos de
  XMLHttpRequest/browser, sin sentido o sin equivalente en Lynx.

**Recomendación**: implementar un `m.request` de v2 que cubra el caso
común (lo que de verdad usa el 90% de las apps: JSON in/out, params,
headers, redraw automático) y **documentar en voz alta, no esconder**,
que `config`/abort/FormData/blob/timeout/credentials/auth básica no están
soportados — con una sugerencia explícita de usar el `fetch` nativo de
Lynx directo para esos casos. No es un "abort total" de la feature, pero
tampoco es un wrapper que un "mithril fan" pueda usar a ciegas asumiendo
paridad completa — hay que ser honesto en el primer párrafo del README de
esta pieza.

---

## 1. Cómo se hace fetch en Lynx

- **API real**: `fetch(input, init?)`, descrita como *"subset of Fetch
  API"* — **es la propia doc de tipos oficial la que dice "subconjunto"**,
  no una inferencia mía (`@lynx-js/types/types/background-thread/fetch.d.ts`,
  línea 185).
- **Solo en el hilo background** — el archivo vive en
  `types/background-thread/`, no en `types/common/` ni `types/main-thread/`.
  Encaja perfecto con la arquitectura de v2: todo el código de vista (y
  por lo tanto cualquier `m.request`) ya corre exclusivamente en
  background (plan `mithril-lynx-v2-desde-cero.md` §3.1) — no hace falta
  ningún puente cross-thread para esto, a diferencia de casi todo lo demás
  en este proyecto.
- **`RequestInit` real (tipos instalados), completo, sin recortar**:
  ```ts
  export interface RequestInit {
    body?: BodyInit | null;
    headers?: HeadersInit;
    method?: string;
    lynxExtension?: { useStreaming?: boolean };
  }
  ```
  Eso es TODO. Compárese con el `RequestInit` real del navegador (que
  tiene además `mode`, `credentials`, `cache`, `redirect`, `referrer`,
  `referrerPolicy`, `integrity`, `keepalive`, `signal`, `window`, ...) —
  Lynx implementa 3 campos más una extensión propia.
- **`Response`/`Request extends Body`**: `arrayBuffer()`, `json()`,
  `text()`. **No `blob()`.** `Response` tiene `headers`, `ok`, `status`,
  `statusText`, `url`, `body` (ReadableStream), `clone()` — esa parte SÍ
  es fiel al spec real de `Response`.
- **Ni `Headers` ni `AbortController` están declarados en
  `@lynx-js/types`** — se usan como tipos referenciados
  (`HeadersInit`, futuro `signal`) pero **no existen como constructor/clase
  en ningún `.d.ts` del paquete**. Esto es una zona gris a confirmar en
  device (§5, spike): ¿existe `Headers` en runtime aunque no esté tipado
  (algo común en engines embebidos), o directamente no existe?
- Confirmado por la doc oficial en texto plano: *"Lynx does not support
  Web-only features like: CORS, redirect, keepalive related APIs.
  FormData/Blob related APIs are not supported."*
- `fetch` mismo llega como variable global inyectada al bundle de
  background — ya lo sabíamos de otro lado: `RuntimeWrapperWebpackPlugin`
  (el mismo plugin que usa `mithril-lynx-v2/plugin.js`) trae `fetch` en su
  lista `defaultInjectVars`, así que no hace falta ni `import`/`require`
  ni acceder vía `lynx.fetch()` explícito — es un global normal, igual que
  en el navegador.

## 2. El contrato real de `m.request` (lo que hay que igualar o declarar no soportado)

Extraído de `node_modules/mithril/request/request.js` (199 líneas, no la
doc — el código real):

| Opción | Mecanismo real (XHR) | ¿Traducible a `fetch` de Lynx? |
|---|---|---|
| `method`, `url`, `params` | `xhr.open(method, url)` + interpolación de `:params` en la URL | **Sí** — `fetch(url, {method})`; interpolación reusa `mithril-runtime/pathname/build.js` (ya vendorizado para `m.route`, cero código nuevo) |
| `body` (objeto plano → JSON) | `xhr.send(JSON.stringify(body))` | **Sí** — `body: JSON.stringify(body)` en `RequestInit`, mismo `Content-Type` header |
| `body` (`FormData`/`URLSearchParams`) | `xhr.send(body)` directo | **No** — Lynx no soporta `FormData`. Body cae siempre al camino JSON o hay que rechazar explícitamente |
| `headers` | `xhr.setRequestHeader(k, v)` por cada key | **Sí** — `RequestInit.headers` acepta un objeto plano (`HeadersInit`) |
| `responseType` (`json`/`text`) | `xhr.responseType` + `xhr.response` | **Sí** — `response.json()` / `response.text()` |
| `responseType: "blob"`/`"document"` | `xhr.responseType = "blob"` | **No** — sin `.blob()` en `Body`; `"document"` no tiene sentido fuera de un DOM de browser |
| `deserialize` | función sobre `xhr.response` | **Sí** — misma función, aplicada al resultado de `.json()`/`.text()` |
| `extract` | `(xhr, options) => any`, salta el flujo normal | **Parcial** — hay que cambiar la firma a `(response, options) => any` (recibe el `Response` de fetch, no un XHR) — **rompe código portado literal**, aunque el propósito (post-proceso custom) se preserva |
| `type` | constructor aplicado al resultado | **Sí**, sin cambios |
| `background` | si es `true`, salta el redraw automático | **Sí** — es lógica pura nuestra (mount-redraw), no toca XHR/fetch para nada |
| Forma del error (`error.code`, `.message`, `.response`) | de `xhr.status`/`xhr.responseText` | **Sí** — `response.status`, `response.statusText`, mismo body ya extraído |
| `config(xhr) => xhr` | mutar el XHR vivo antes de `.send()` | **No hay traducción real** — lo más cercano es un `config(requestInit) => requestInit` que mute el `RequestInit` ANTES de llamar `fetch()`, pero es una firma y un momento distintos; código que use `config` para engancharse a `xhr.onprogress`, reemplazar el XHR, etc. **no tiene forma de portarse** |
| `timeout` | `xhr.timeout` nativo, aborta la conexión real | **No fielmente** — sin `AbortController` en Lynx, un timeout hecho con `Promise.race` rechaza la promesa en el tiempo esperado, pero **el fetch real sigue viajando por la red sin cancelarse** — comportamiento observable distinto (ver §4) |
| Cancelación (`.abort()` vía `config`) | `xhr.abort()` | **No** — sin `AbortController`/`AbortSignal` en los tipos de Lynx, no hay forma de cancelar un fetch en vuelo |
| `withCredentials` | `xhr.withCredentials = true` (cookies cross-origin) | **No aplica** — Lynx no tiene modelo de origen/CORS; la opción quedaría como no-op silencioso si se acepta tal cual |
| `user`/`password` | pasados a `xhr.open(...)`, auth básica HTTP | **No hay equivalente directo** — habría que armar el header `Authorization: Basic ...` a mano, y eso requiere `btoa()`, cuya disponibilidad en Lynx no está confirmada (no se investigó en esta sesión) |
| `async: false` (modo síncrono) | `xhr.open(..., false, ...)` | **Imposible** — no existe un `fetch` síncrono en ningún entorno, browser o Lynx |

## 3. No-objetivos explícitos (documentados, no escondidos)

Si se implementa (fase futura, no esta sesión), el `README`/`.d.ts` de
`mithril-lynx-v2/request` debe decir, en la primera pantalla, sin que haga
falta buscarlo:

- `config` cambia de firma (`RequestInit`, no `XMLHttpRequest`) — código
  portado de un `m.request` real que use `config` para algo más que setear
  un header necesita revisión manual, no es un cambio de import.
- No hay cancelación de requests en vuelo (ni por API propia ni por
  `config`).
- No hay `timeout` con corte real de la conexión — como mucho, "dejar de
  esperar" sin cancelar el trabajo de red de fondo (documentado como una
  degradación conocida, ver §4 para la decisión exacta).
- Sin soporte de `FormData`/`URLSearchParams`/`Blob` — cualquier caso de
  subida de archivos o multipart queda fuera de alcance por completo.
- Sin `withCredentials`, sin `user`/`password` — si hace falta auth
  básica, armar el header `Authorization` manualmente en `headers`.
- Sin modo síncrono (`async: false`).

## 4. Puntos que necesitan un spike en device antes de programar nada

1. **¿Existe `Headers` como constructor en runtime, aunque no esté en los
   `.d.ts`?** Los tipos no lo declaran, pero eso no prueba que el motor
   real tampoco lo tenga (paquetes de tipos quedan desactualizados o
   incompletos). Probar `typeof Headers` en el hilo background de un
   device real.
2. **¿Qué pasa con una respuesta 3xx (redirect)?** La doc dice "no soporta
   redirect" pero no dice qué pasa en la práctica: ¿el fetch de Lynx sigue
   el redirect igual (como XHR, transparente) o falla/devuelve la
   respuesta 3xx cruda? Esto cambia si hace falta advertir sobre esto o
   no.
3. **¿`btoa`/`atob` existen en el hilo background?** Necesario si se
   decide ofrecer un helper de auth básica en vez de dejarlo 100% a mano
   del usuario.
4. **Confirmar si `AbortController` existe en runtime pese a no estar
   tipado** — de existir, cambia el veredicto de "timeout real
   imposible" a "timeout real posible, solo falta tipar la firma
   nosotros mismos en el `.d.ts` de v2".

## 5. Si se decide implementar: forma concreta (fase futura, no esta sesión)

Mismo patrón que `mithril-lynx-v2/route`: un subpath export nuevo
(`mithril-lynx-v2/request`), NO agregado al core (`renderApp`) — es
opcional, un consumidor que no lo importe no paga nada por él.

```js
// forma esperada, análoga a m.request real
import request from "mithril-lynx-v2/request";

request("/api/users/:id", { params: { id: 42 } })
  .then((user) => { ... });
```

Reutiliza `mithril-runtime/pathname/build.js` (ya vendorizado para
`m.route`) para la interpolación de `:params` en la URL — mismo motor,
cero código nuevo ahí. El resto (armar `RequestInit`, llamar `fetch`,
aplicar `deserialize`/`extract`/`type`, construir el error con
`response.status`) es código nuevo pero acotado — el propio
`request/request.js` real (199 líneas) da la plantilla exacta de qué
casos cubrir, con las opciones de la tabla de §2 marcadas como
"soportado"/"no soportado" desde el día uno.

**Integración con redraw**: igual que `m.route`, el flag `background`
decide si se llama al único `performRender`/commit de la app
(`background.js`) al resolver la promesa — reusa el mismo mecanismo,
no inventa un segundo camino de redraw.

## 6. Referencias

- Spec real de `m.request`: <https://mithril.js.org/request.html>
- `fetch` de Lynx (doc): <https://lynxjs.org/api/lynx-api/global/fetch.html>
- Tipos reales instalados (evidencia, no doc):
  `@lynx-js/types/types/background-thread/fetch.d.ts`,
  `@lynx-js/types/types/background-thread/lynx.d.ts`
- Código fuente real de `m.request`:
  `node_modules/mithril/request/request.js` (mithril 2.3.8, mismo
  checkout que ya usa `mithril-runtime`)
- Precedente directo de esta sesión: `m-route-en-memoria.md` — mismo
  patrón de "vendorizar la parte pura de Mithril, reimplementar la parte
  atada a browser sobre la primitiva de Lynx equivalente, documentar la
  brecha sin esconderla".
