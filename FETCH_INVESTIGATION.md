# `m.request` vs el `fetch` de Lynx — investigación completa

Documento de referencia, no un plan — el plan que consumió esta
investigación (con su narrativa de spikes y decisiones) está en
[`.omo/plans/m-request-fetch-lynx.md`](.omo/plans/m-request-fetch-lynx.md).
Este archivo es el consolidado técnico: qué es cada API, qué dice cada
fuente, y qué se confirmó de verdad en un device real — para consultar
sin tener que reconstruir la investigación de nuevo.

**Metodología**: tres fuentes independientes, en orden de confiabilidad
creciente — (1) prosa de documentación oficial, (2) `.d.ts` reales
instalados de `@lynx-js/types` (evidencia de tipos), (3) **pruebas
ejecutadas en un device Android real** (`adb`, `agent-lynx evaluate`
contra el hilo background de una app Lynx corriendo). Las fuentes 1 y 2
se equivocaron dos veces cada una — ver §4 — así que ninguna afirmación
de este documento se da por buena solo por estar documentada o tipada:
donde hay una fila marcada "confirmado en device", es porque se ejecutó
código real y se leyó el resultado real.

---

## 1. El spec: `m.request` real

Fuente: [`mithril.js.org/request.html`](https://mithril.js.org/request.html)
+ el código fuente real, `node_modules/mithril/request/request.js`
(mithril 2.3.8, 199 líneas — el mismo checkout que usa `mithril-runtime`).

```js
promise = m.request(options)
promise = m.request(url, options)
```

| Opción | Tipo | Qué hace |
|---|---|---|
| `method` | string | GET por defecto |
| `url` | string | soporta interpolación `:param` |
| `params` | object | interpola en la URL y/o query string |
| `body` | object/FormData/URLSearchParams | serializado al request body |
| `async` | boolean | `xhr.open(..., async, ...)` — default `true` |
| `user`/`password` | string | HTTP Basic Auth vía `xhr.open(...)` |
| `withCredentials` | boolean | cookies cross-origin |
| `timeout` | number | ms, aborta la conexión real vía `xhr.timeout` |
| `responseType` | string | default `"json"` |
| `headers` | object | por header, `xhr.setRequestHeader` |
| `serialize`/`deserialize` | function | por default JSON |
| `type` | function | constructor aplicado al resultado |
| `extract` | function | `(xhr, options) => any`, se salta deserialize |
| `config` | function | `(xhr, options, url) => xhr\|void` — mutar el XHR vivo antes de enviarlo |
| `background` | boolean | si `true`, no dispara redraw al completar |

**El mecanismo real es `XMLHttpRequest`, no `fetch`.** Esto es textual en
la doc, y se confirma leyendo el código: `xhr.open`, `xhr.send`,
`xhr.abort`, `xhr.responseType`, `xhr.withCredentials`, `xhr.timeout`,
`xhr.onreadystatechange`. El error resultante trae `error.code` (status
HTTP), `error.message` (texto de la respuesta), `error.response`
(cuerpo ya parseado).

---

## 2. El `fetch` de Lynx

Fuentes: doc oficial
[`lynxjs.org/api/lynx-api/global/fetch.html`](https://lynxjs.org/api/lynx-api/global/fetch.html)
y los `.d.ts` reales instalados en
`@lynx-js/types/types/background-thread/fetch.d.ts` +
`.../lynx.d.ts`.

### 2.1 Dónde vive

`fetch` está declarado como método del objeto `Lynx` dentro de
`types/background-thread/` — **solo existe en el hilo background**, no
en `common/` ni `main-thread/`. Encaja con la arquitectura entera de
`mithril-lynx` (toda la vista corre en background) — no hace falta
ningún puente cross-thread para esto.

### 2.2 La firma real, completa, sin recortar

```ts
export interface RequestInit {
  body?: BodyInit | null;
  headers?: HeadersInit;
  method?: string;
  lynxExtension?: { useStreaming?: boolean };
}
```

Eso es todo el `RequestInit`. El comentario del propio archivo de tipos
dice, textual: **`"@description subset of Fetch API"`** — es la fuente
oficial de Lynx reconociendo que es un subconjunto, no una afirmación
mía.

Comparado con el `RequestInit` real de un navegador (que además tiene
`mode`, `credentials`, `cache`, `redirect`, `referrer`, `referrerPolicy`,
`integrity`, `keepalive`, `signal`, `window`) — Lynx implementa 3 campos
más una extensión propia.

`Body` (que `Request`/`Response` extienden): `arrayBuffer()`, `json()`,
`text()`. **Sin `.blob()`.**

### 2.3 Lo que la doc dice en texto plano

> "Lynx does not support Web-only features like: CORS, redirect,
> keepalive related APIs. FormData/Blob related APIs are not supported."

---

## 3. Comparación completa, opción por opción

| Opción de `m.request` | ¿Se puede replicar sobre `lynx.fetch`? | Evidencia |
|---|---|---|
| `method`, `url`, `params` | **Sí** | `fetch(url, {method})`; interpolación reusa `mithril-runtime/pathname/build.js` |
| `body` (objeto → JSON) | **Sí** | `body: JSON.stringify(body)` |
| `body` (`URLSearchParams`) | **Sí** | Confirmado en device: `Content-Type: application/x-www-form-urlencoded` automático, campos bien parseados del otro lado |
| `body` (`FormData`) | **No** | Confirmado en device: `typeof FormData === "undefined"` |
| `headers` (escribir) | **Sí** | `new Headers({...})` o objeto plano, ambos llegan bien al servidor (confirmado en device contra `httpbin.org/headers`) |
| `headers` (leer con `.get()`/`.has()`) | **Parcial** | Confirmado en device: **case-sensitive**, no case-insensitive como el spec real (`h.set("X-Test",...); h.get("x-test")` → `null`) |
| `responseType: "json"/"text"` | **Sí** | `response.json()` / `.text()` |
| `responseType: "blob"` | **No** | Sin `.blob()` en `Body` (tipos) |
| `deserialize` | **Sí** | misma función sobre el resultado de `.json()`/`.text()` |
| `extract` | **Parcial** | firma cambia: `(response, options)` en vez de `(xhr, options)` — el propósito se preserva, el código portado literal no |
| `type` | **Sí** | sin cambios |
| `background` | **Sí** | lógica pura, no toca fetch/XHR para nada |
| Forma del error | **Sí** | `response.status`, `.statusText`, body ya extraído |
| `config(xhr)` | **No** | sin equivalente — `fetch` no da un objeto vivo para mutar a mitad de vuelo |
| `timeout` (corte real) | **Sí** | confirmado en device: `AbortController` + `lynx.setTimeout` corta la conexión real (ver §4.4) |
| Cancelación (`.abort()`) | **Sí** | `AbortController`/`AbortSignal` existen y funcionan pese a no estar tipados |
| Redirects (3xx) | **Sí, transparente** | confirmado en device: sigue el redirect solo, como un browser real |
| `response.url`/`.redirected` tras un redirect | **No confiable** | confirmado en device: quedan con la URL/estado de ANTES del redirect |
| `withCredentials` | **No aplica** | Lynx no tiene modelo de origen/CORS |
| `user`/`password` (Basic Auth) | **No hay equivalente directo** | requeriría armar el header a mano — y sin `btoa` (confirmado ausente), sin una implementación propia de base64 |
| `async: false` (modo síncrono) | **Imposible** | no existe un fetch síncrono en ningún entorno |

---

## 4. Evidencia de device — el detalle de cada corrida

Device: `adb R8YYC0VV0PV` (Samsung SM-A075M), sesión de
`mithril-lynx-v2-app` vía `agent-lynx evaluate` (background thread).
Fecha: 2026-09-18.

**Nota de herramienta**: `agent-lynx evaluate` espera una única
EXPRESIÓN — cualquier cosa con `;` a nivel superior tira
`SyntaxError: expecting ')'` desde el wrapper interno de la herramienta,
no del código evaluado. Solución: envolver todo en un IIFE
`(function(){ ...; return valor; })()`.

### 4.1 Primitivas: existen o no

```js
JSON.stringify({
  Headers: typeof Headers, AbortController: typeof AbortController,
  AbortSignal: typeof AbortSignal, btoa: typeof btoa, atob: typeof atob,
  fetch: typeof fetch, Request: typeof Request, Response: typeof Response,
})
// → {"Headers":"function","AbortController":"function","AbortSignal":"function",
//    "btoa":"undefined","atob":"undefined","fetch":"undefined",
//    "Request":"function","Response":"function"}
```

```js
JSON.stringify({FormData: typeof FormData, Blob: typeof Blob, URLSearchParams: typeof URLSearchParams})
// → {"FormData":"undefined","Blob":"undefined","URLSearchParams":"function"}
```

```js
JSON.stringify({lynxFetch: typeof lynx.fetch, globalThisFetch: typeof globalThis.fetch})
// → {"lynxFetch":"function","globalThisFetch":"undefined"}
```

**Conclusión**: `Headers`, `AbortController`, `AbortSignal`,
`URLSearchParams`, `Request`, `Response` existen. `btoa`, `atob`,
`FormData`, `Blob`, y el `fetch` global (sin `lynx.`) NO existen. Hay que
llamar siempre `lynx.fetch(...)`.

### 4.2 Redirect (3xx)

```js
lynx.fetch("https://httpbin.org/redirect-to?url=https://example.com")
// status: 200, ok: true, body: el HTML real de example.com
// response.url: sigue siendo la URL de httpbin (la ORIGINAL, no la final)
// response.redirected: undefined
```

El redirect se sigue solo, transparente. Los metadatos sobre el redirect
(`url`, `redirected`) no reflejan la realidad.

### 4.3 Headers: escribir funciona, leer con case distinta no

```js
var h = new Headers();
h.set("X-Test", "abc");
h.get("X-Test")   // "abc"
h.get("x-test")   // null  <-- debería ser "abc", Headers es case-insensitive en el spec real
h.has("x-test")   // false
```

Enviar headers a un servidor real (`httpbin.org/headers`) funciona
perfecto — el servidor recibe la clave y el valor correctos. El problema
es específico de leer de vuelta una instancia de `Headers` con una
capitalización de clave distinta a la usada para escribirla.

### 4.4 `AbortController`: existe y cancela de verdad

Abort inmediato:
```js
var ctrl = new AbortController();
lynx.fetch(url, {signal: ctrl.signal}).catch(e => ...); // e.name === "AbortError"
ctrl.abort();
// → {name: "AbortError", message: "This operation was aborted"}
```

Abort a mitad de vuelo (la prueba que de verdad importa — que la
conexión se corte, no que la promesa simplemente deje de esperar):
```js
var ctrl = new AbortController();
var t0 = Date.now();
lynx.fetch("https://httpbin.org/delay/5", {signal: ctrl.signal})
  .catch(e => { /* elapsedMs = Date.now() - t0 */ });
lynx.setTimeout(() => ctrl.abort(), 800);
// → rechazó a los 805ms, NO a los 5000ms del delay real del servidor
```

**La conexión se cortó de verdad** — no fue una promesa que se rindió
mientras la red seguía trabajando de fondo.

### 4.5 `URLSearchParams` como body

```js
lynx.fetch("https://httpbin.org/post", {
  method: "POST",
  body: new URLSearchParams({foo: "bar", baz: "42"}),
})
// el servidor recibió: form: {foo:"bar", baz:"42"}
// Content-Type enviado: application/x-www-form-urlencoded;charset=UTF-8 (automático)
```

Funciona exactamente como en un browser real.

### 4.6 `lynx.setTimeout`/`requestAnimationFrame` NO esperan a que drene la cola de microtasks

Este no es un hallazgo de `fetch` en sí, sino algo descubierto implementando
el redraw automático de `request.js` (`src/mount-redraw.js`) — documentado
acá porque cualquier wrapper sobre una promesa de `lynx.fetch` que dispare
un timer choca con lo mismo.

En un motor JS spec-compliant, un macrotask (`setTimeout`, `requestAnimationFrame`)
SIEMPRE corre después de que la cola de microtasks actual drena por
completo, sin importar cuántos `.then()` encadenados haya. En este runtime
de Lynx (hilo background) eso NO se cumple:

```js
Promise.resolve()
  .then(() => console.log("microtask 1"))
  .then(() => console.log("microtask 2"))
  .then(() => console.log("microtask 3"));
lynx.setTimeout(() => console.log("timeout"), 0);
// orden real observado: timeout, microtask 1, microtask 2, microtask 3
```

Confirmado con delays de 0, 1, 4 y 16ms — todos perdieron la carrera contra
el primer microtask. `lynx.requestAnimationFrame` tiene el mismo problema
(mismo test, mismo resultado: `raf-fired` antes que `microtask 1`).

**Por qué importa**: `request()` resuelve internamente (`bodyPromise.then(...)`)
y llama `sharedRedraw()` en su propio `.then(onSuccess)` — que corre UN
microtask antes que el `.then()` que el caller encadena sobre la promesa
que `request()` le devuelve. Si el redraw se dispara síncrono (o vía un
timer de 0-16ms), el render ocurre ANTES de que el caller haya guardado la
respuesta en su propio estado — la UI queda congelada mostrando el estado
"loading" para siempre, sin ningún error en consola. Confirmado en device
con la demo `fetch-demo.ts`: `status` se actualizaba a `"done"` en memoria
(logueado) pero la pantalla seguía mostrando `"loading"` indefinidamente.

**Mitigación aplicada**: `mount-redraw.js` usa un delay de 50ms — el primer
valor que ganó la carrera de forma repetible contra el caso realista (un
solo `.then()` encadenado). No es una garantía formal como la de un
macrotask real, es un margen empírico. Documentado acá en vez de
escondido, siguiendo el mismo criterio del resto de este archivo.

---

## 5. Veredicto

**El gap es real pero acotado, y más chico de lo que sugerían los tipos
instalados.** Los puntos genuinamente irreparables son pocos y bien
delimitados: el hook `config(xhr)` (ningún equivalente posible con
`fetch`), `FormData`/`Blob`, auth básica inline (`user`/`password`, sin
`btoa`), y el modo síncrono (`async: false`). Todo lo demás — incluida
cancelación y timeout reales, que en la primera pasada de esta
investigación parecían imposibles — funciona.

**Recomendación**: implementar el subconjunto confirmado como
`mithril-lynx/request`, documentando explícitamente (no escondiendo)
los 4-5 puntos sin equivalente, con una sugerencia directa de usar
`lynx.fetch` nativo para esos casos puntuales.

---

## 6. Referencias

- Spec real: <https://mithril.js.org/request.html>
- `fetch` de Lynx (doc): <https://lynxjs.org/api/lynx-api/global/fetch.html>
- Tipos reales: `@lynx-js/types/types/background-thread/{fetch,lynx}.d.ts`
- Código fuente real de `m.request`: `node_modules/mithril/request/request.js`
- Plan que usa esta investigación: [`.omo/plans/m-request-fetch-lynx.md`](.omo/plans/m-request-fetch-lynx.md)
- Implementación resultante: `src/request.js` (ver ese archivo para el
  estado actual de qué de esta tabla ya está construido)
