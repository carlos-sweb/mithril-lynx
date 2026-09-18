# Plan — `m.request` para mithril-lynx-v2: ¿alcanza el `fetch` de Lynx?

> Estado (2026-09-18): **Investigación + spike en device COMPLETOS,
> veredicto corregido con evidencia real — implementación NO iniciada.**
> Idioma: español. Insumo de las 2 tareas solicitadas: (1) cómo se hace
> fetch en Lynx, (2) si el `fetch` de Lynx cumple lo que `m.request`
> (spec: <https://mithril.js.org/request.html>) espera. Fuentes: doc
> oficial de Mithril, doc oficial de Lynx
> (`lynxjs.org/api/lynx-api/global/fetch.html`), los `.d.ts` instalados de
> `@lynx-js/types`, el código fuente real de `m.request`
> (`node_modules/mithril/request/request.js`, 199 líneas), **y las 4
> preguntas del spike respondidas en un device real conectado** (ver §4 —
> **los tipos mentían en dos de los cuatro puntos**: `AbortController`/
> `AbortSignal`/`Headers` SÍ existen y funcionan en runtime pese a no
> estar declarados en `@lynx-js/types`).

---

## Veredicto (primero, para no enterrarlo)

**El gap es más chico de lo que sugerían los tipos instalados —
cancelación y timeout reales SÍ son posibles.** El spike en device
(§4) corrigió dos de las cuatro preguntas abiertas en la dirección
optimista: `@lynx-js/types` no declara `AbortController`, pero el device
real lo tiene, funciona spec-compliant, y **cancela la conexión de
verdad** (probado: abort a los 800ms de una respuesta que tarda 5000ms →
la promesa rechazó a los 805ms, no a los 5000ms — no es un timeout de
mentira que espera igual). Eso cambia la lista de "imposible" a una lista
más corta:

- `config(xhr) => xhr` (el escape hatch de la API real) — sigue sin
  traducción posible: `fetch` no expone un objeto vivo para mutar a mitad
  de vuelo. Esto no lo arregla el spike.
- `FormData`/`URLSearchParams` como body — la doc de Lynx dice
  explícitamente que no están soportados (no se re-probó en device, la
  doc + los tipos coinciden en esto, suficiente certeza).
- `responseType: "blob"` — `Body` en Lynx solo tiene `arrayBuffer()`,
  `json()`, `text()`. Sin `.blob()`.
- `withCredentials`, `user`/`password` (auth básica vía `xhr.open`),
  `async: false` (modo síncrono) — conceptos exclusivos de
  XMLHttpRequest/browser, sin sentido o sin equivalente en Lynx. Además,
  **`btoa`/`atob` confirmados ausentes en runtime** (spike §4) — armar el
  header `Authorization: Basic` a mano necesitaría una implementación
  propia de base64, no solo un one-liner.
- **Cancelación y timeout**: YA NO están en la lista de imposibles —
  `AbortController` funciona de verdad (§4). Un `m.request` de v2 puede
  ofrecer cancelación real y un `timeout` que efectivamente corta la
  conexión, no una promesa que se rinde mientras la red sigue trabajando
  de fondo (que era el peor escenario que planteaba la versión anterior de
  este documento).

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
  (`HeadersInit`, futuro `signal`) pero no existen como constructor/clase
  en ningún `.d.ts` del paquete. **Confirmado en device (§4): los tipos
  mienten acá — ambos existen y funcionan en runtime.** Los tipos de
  `@lynx-js/types` están incompletos/desactualizados en este punto, no son
  la fuente de verdad final — un recordatorio general para el resto de
  este proyecto, no solo para `m.request`.
- Confirmado por la doc oficial en texto plano: *"Lynx does not support
  Web-only features like: CORS, redirect, keepalive related APIs.
  FormData/Blob related APIs are not supported."*
- **`fetch` NO es un global usable — hay que llamar `lynx.fetch(...)`
  explícito.** Corrección respecto a una suposición anterior de este
  documento: aunque `RuntimeWrapperWebpackPlugin` incluye `"fetch"` en su
  lista `defaultInjectVars`, el spike en device (§4) confirmó
  `typeof fetch === "undefined"` mientras `typeof lynx.fetch ===
  "function"` en el mismo contexto. `indicadores-app` (la app de
  referencia que el usuario señaló) ya usa `lynx.fetch(...)` por esta
  misma razón — coincide con la evidencia del spike, no es una casualidad
  de esa app.

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
| `timeout` | `xhr.timeout` nativo, aborta la conexión real | **Sí, de verdad** — `AbortController` + `lynx.setTimeout(() => ctrl.abort(), ms)` **cancela la conexión real**, confirmado en device (§4): abort a los 800ms de una respuesta de 5000ms rechazó a los 805ms, no a los 5000ms. Firma distinta a `xhr.timeout` (hay que armar el controller nosotros) pero el resultado observable es el mismo |
| Cancelación (`.abort()` vía `config`) | `xhr.abort()` | **Sí** — `AbortController`/`AbortSignal` existen y funcionan en runtime pese a no estar en `@lynx-js/types` (confirmado en device, §4). `m.request` de v2 puede exponer su propio `.abort()`/aceptar un `signal` propio |
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
- Sin soporte de `FormData`/`URLSearchParams`/`Blob` — cualquier caso de
  subida de archivos o multipart queda fuera de alcance por completo.
- Sin `withCredentials` (no aplica, Lynx no tiene modelo de CORS/origen) y
  sin `user`/`password` inline — si hace falta auth básica, armar el
  header `Authorization` a mano (y una función de base64 propia, ya que
  `btoa` no existe — confirmado en device, §4).
- Sin modo síncrono (`async: false`) — no existe en ningún fetch, browser
  o Lynx.
- `response.url`/`response.redirected` no reflejan la URL final tras un
  redirect (confirmado en device, §4) — si el código de la app depende de
  saber a qué URL terminó yendo la request tras redirects, esto no
  funciona igual que en un browser real.
- `Headers.get()` no confirmado como confiable para LEER de vuelta
  (ver §4, hallazgo extra) — construir/enviar headers con `new Headers()`
  sí funciona.

**Ya NO son no-objetivos** (el spike de §4 los movió a la columna de "sí
se puede"): cancelación de requests en vuelo, y `timeout` con corte real
de la conexión — ambos funcionan de verdad vía `AbortController`.

## 4. Spike en device — las 4 preguntas, respondidas (2026-09-18, adb R8YYC0VV0PV)

Corrido con `agent-lynx evaluate` contra el background thread de
`mithril-lynx-v2-app` en el device conectado — no contra
`indicadores-app` (el usuario señaló esa app como referencia de que
"fetch funciona ahí", y es cierto, pero solo ejercita el camino feliz
básico: `lynx.fetch(url)` + `.ok` + `.json()`, sin tocar ninguna de las
4 preguntas de este spike).

**Nota de herramienta**: `agent-lynx evaluate` espera una única
EXPRESIÓN, no una secuencia de sentencias con `;` — expresiones con
`;` al nivel superior tiran `SyntaxError: expecting ')'` desde el wrapper
interno de la herramienta. Solución: envolver todo en un IIFE
`(function(){ ...sentencias...; return valor; })()`, que sí es una sola
expresión. Documentado acá para la próxima sesión que use este spike.

1. **¿Existe `Headers`/`AbortController`/`AbortSignal` en runtime pese a
   no estar en `@lynx-js/types`?** `typeof Headers` → `"function"`,
   `typeof AbortController` → `"function"`, `typeof AbortSignal` →
   `"function"`. **Los tres existen.** Los tipos instalados están
   incompletos en este punto, no son la fuente de verdad final.
2. **¿Qué pasa con un 3xx?** `lynx.fetch("https://httpbin.org/redirect-to?url=https://example.com")`
   devolvió `status: 200`, `ok: true`, y el body fue el HTML real de
   `example.com` — **Lynx sigue el redirect solo**, transparente, como un
   browser real. Pero `response.url` quedó con la URL ORIGINAL
   (`httpbin.org/redirect-to?...`), no la final — y `response.redirected`
   vino `undefined`. El redirect en sí funciona; los metadatos sobre el
   redirect no son confiables.
3. **¿Existen `btoa`/`atob`?** `typeof btoa` → `"undefined"`, `typeof atob`
   → `"undefined"`. **Confirmado ausentes.** Un helper de auth básica
   necesitaría una implementación propia de base64.
4. **¿`AbortController` funciona de verdad (no solo existe)?** Sí,
   spec-compliant: `ctrl.abort()` inmediato → la promesa rechaza con
   `{name: "AbortError", message: "This operation was aborted"}`.
   Prueba más fuerte — abort a mitad de vuelo: `lynx.fetch(".../delay/5",
   {signal: ctrl.signal})` + `lynx.setTimeout(() => ctrl.abort(), 800)` →
   la promesa rechazó a los **805ms**, no a los 5000ms del delay real del
   servidor — **la conexión se cortó de verdad**, no fue una promesa que
   se rindió mientras la red seguía trabajando.

**Hallazgo extra, no una de las 4 preguntas originales pero relevante**:
`fetch` global (bare, sin `lynx.`) es `undefined` — hay que llamar
`lynx.fetch(...)` siempre. Se había asumido lo contrario en una versión
anterior de este documento (por estar `"fetch"` en la lista
`defaultInjectVars` de `RuntimeWrapperWebpackPlugin`) — el spike lo
corrigió. Coincide con que `indicadores-app` (la app que el usuario
señaló) ya usa `lynx.fetch(...)` explícito, no por casualidad.

Segundo hallazgo extra: `new Headers({...})` pasado a
`fetch(url, {headers})` **sí llega bien al servidor** (confirmado con
`https://httpbin.org/headers`, que devuelve de vuelta los headers que
recibió) — pero `headersInstance.get("x-test")` sobre esa misma instancia
devolvió `null` en vez del valor puesto. Construir/enviar headers
funciona; leer de una instancia de `Headers` con `.get()` no se puede dar
por confiable sin una segunda vuelta de investigación (no bloqueante para
`m.request`, que nunca necesita leer una `Headers` que armó él mismo).

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

**Cancelación/timeout** (nuevo respecto a la versión anterior de este
plan, gracias al spike de §4): cada llamada arma su propio
`AbortController` internamente. `timeout` (si se pasa) hace
`lynx.setTimeout(() => ctrl.abort(), timeout)` y limpia el timer si la
promesa ya resolvió. La función devuelta por `request(...)` puede colgar
un `.abort()` propio (no existe en la promesa real de mithril, pero es
gratis tenerlo acá y es justo lo que un "mithril fan" pediría después de
la falta de `config`) que llama `ctrl.abort()` directo — capacidad nueva
que ni el `m.request` real ofrece de forma tan directa (ahí hay que pasar
por `config` para llegar al `xhr.abort()`).

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
