# Plan — mithril-lynx v2: reescritura completa, redraw automático, 3 modos de reload

> Estado (2026-09-17): **F0, F1 y F2 completados y verificados con
> `rstest` (no mocks — PAPI real vía `@lynx-js/testing-environment`).**
> F3–F6 pendientes (necesitan build real + device). Código en
> `mithril-lynx-v2/src/`, commit inicial `87c1a36`, git local (sin remoto).
> Ver §8 al final de este documento para el detalle exacto de qué quedó
> hecho, con evidencia. Idioma: español (consistente con el resto de planes
> de este proyecto).
>
> Decisión del usuario (2026-09-17): v2 se escribe en un directorio hermano
> nuevo, `mithril-lynx-v2/`, **no** dentro de `mithril-lynx/`. Motivo textual:
> *"no quiero hacerlo en el directorio actual, por que no quiero que queden
> cabos sueltos"*. `mithril-lynx/` (v1) queda intacto, de solo lectura, como
> referencia — no se borra, no se toca, no se le agregan más parches.
>
> Insumo principal: `../../rspeedy-react-analysis/LYNX_PAPI_SPEC.md` —
> investigación de cómo ReactLynx realmente logra redraw automático y reload
> ligero, leyendo su código fuente real (no el REPORT.md anterior, que era
> superficial). Este plan traduce esos hallazgos en decisiones de arquitectura
> para v2. Todas las citas `§N` de ese documento se refieren a él.

---

## 0. Por qué una v2 desde cero y no un fix de v1

v1 (`mithril-lynx/`) llegó a un punto donde cada solución generó un cabo
suelto nuevo:

- El reload ligero (F0–F2 del plan viejo, `mithril-lynx/.omo/plans/arquitectura-dual-reload.md`)
  quedó funcionando para el caso feliz, pero la forma de lograrlo — monkey-
  patch de `lynx.requireModuleAsync` en runtime, un `if (typeof
  globalThis.__FlushElementTree !== "function")` condicional para decidir si
  el hook de flush existe — son parches sobre síntomas, no un diseño.
- La regresión activa ahora mismo (auto-redraw tras un evento no llega al
  main-thread; test `renderer-integration.test.ts` en rojo) es consecuencia
  directa de eso: el punto de "flush" del framework es opcional/condicional
  en vez de ser un contrato fijo instalado una sola vez.
- `LYNX_PAPI_SPEC.md` mostró que varias de las decisiones de v1 no son las
  que usa el propio ReactLynx (canal de patch, guard de race, cómo se evita
  el error de `exports`, cómo se reconcilia un reload) — no son ajustes
  incrementales, son otra arquitectura. Mezclarlas a mitad de v1 hubiera
  significado reescribir el core de todos modos.

Conclusión: reescribir desde cero, con el contrato correcto desde el primer
commit, es más barato que seguir apilando parches sobre v1.

---

## 1. Objetivo

Un framework mithril-sobre-Lynx que iguale el contrato de desarrollo de
ReactLynx en dos frentes concretos:

1. **Redraw automático genuino.** Un handler de evento (`ontap`, etc.) que
   muta estado actualiza la pantalla sin que el código de la app llame nada
   — nada de `shim.redraw()`/`m.redraw()` a mano como paso obligatorio (hoy
   sigue existiendo como API, igual que en React con `setState`, pero
   **nunca** debe ser el único camino para que algo se pinte).
2. **Tres modos de reload**, no dos — el usuario ya lo señaló y
   `LYNX_PAPI_SPEC.md` §4.4 lo confirmó con evidencia de código real:
   - **A — Light reload de datos**: texto/props/CSS. Ya validado en v1,
     se rediseña sobre el core nuevo.
   - **B — Light reload estructural**: agregar/quitar/reordenar nodos del
     árbol (lo que v1 asumía que *tenía* que ser full reload). ReactLynx lo
     resuelve mandando el nuevo template compilado por el MISMO canal de
     patch (`DEV_ONLY_AddSnapshot`); v2 lo resuelve dejando que el diff
     normal de Mithril (que corre en background contra un árbol real)
     produzca los ops de Create/Insert/Remove que hagan falta — no necesita
     un "modo" de wire protocol aparte, necesita que la reconciliación no
     tire elementos que no cambiaron (ver §3.6).
   - **C — Full reload**: fallback para lo que A/B no pueden resolver
     (imports nuevos, dependencias cambiadas, error irrecuperable). Ya
     estable en v1 desde 0.0.9 (commit `74fcf9f`, vía CDP `Page.reload`) —
     se reutiliza el mecanismo, reescrito sobre el core nuevo.

---

## 2. No-objetivos (explícitos, para no repetir el scope creep de v1)

- **No portar código de v1.** Está permitido releer v1 y reimplementar
  conceptos ya validados en device (el wrapper de Element PAPI del
  main-thread, gestos, listas — ver `mithril-lynx/CONTRACT.md` y
  `DEVICE_VERIFICATION.md`), pero como código nuevo escrito para el
  contrato v2, no copy-paste.
- **No HMR de "worklets"/funciones main-thread-script.** mithril-lynx no
  tiene ese concepto todavía; ReactLynx tampoco lo resolvió (`hmr.js`:
  *"disable hmr until bugs are fixed"*, sin arreglar). No se persigue acá.
- **No compilador de templates (SWC) propio.** v2 sigue interpretando
  hyperscript de Mithril en runtime, como v1 — no precompila `create()`/
  `update[]` por posición como hace ReactLynx. Es una limitación de
  performance aceptada conscientemente, no un bloqueo para el reload.
- **No se mantienen los 3 modos de render de v1** (main-thread-owned,
  data-channel, renderer). v2 nace con **un solo modo**: vista real en
  background contra árbol virtual, patch al main-thread — es el único que
  puede dar reload ligero, que es el objetivo declarado. Si en el futuro
  hace falta un modo "sin background" por alguna razón de performance, es
  una v3, no parte de este plan.

---

## 3. Arquitectura (decisiones tomadas — no todas están abiertas a discusión, ver F0 para las que sí)

### 3.1 Modelo de hilos: uno solo

Toda la vista (Mithril real, diff real) corre en el hilo **background**
contra un árbol virtual (equivalente al `VirtualNodeWrapper` que v1 ya tiene
en `internal/virtual-node.js` — reimplementado, no copiado). El
**main-thread** solo aplica un patch contra elementos PAPI reales — nunca
ejecuta lógica de vista. Esto es lo que v1 llamó "renderer mode" y ya
verificó on-device (F1/F2 del plan viejo) — la decisión acá es que en v2
**no hay alternativa**, no que se descubre de nuevo.

### 3.2 Canal cruzado background → main: a decidir con evidencia (F0)

`LYNX_PAPI_SPEC.md` §3 documentó que ReactLynx usa
`lynx.getNativeApp().callLepusMethod(name, payload, callback)` — una
llamada nativa directa con callback de confirmación — en vez de un evento
genérico (`lynx.getCoreContext().dispatchEvent()`, que es lo que usa v1
hoy). No sabemos todavía si `callLepusMethod`/el mecanismo de "calledByNative
globals" es parte de la PAPI pública general o es infraestructura interna
exclusiva de `@lynx-js/react`. **Regla de decisión (F0.1):**

- Si `callLepusMethod` (o equivalente) funciona desde un bundle sin
  `@lynx-js/react` → v2 lo adopta. Ventaja: callback de confirmación nativo,
  sin depender de que el main-thread ya esté escuchando un evento.
- Si no está expuesto a terceros → v2 se queda con el canal de evento
  custom que v1 ya tiene funcionando (`lynx.getCoreContext().dispatchEvent`
  con nombre de evento propio) — es una degradación aceptable, no
  bloqueante, porque ya está validado en device.

### 3.3 Formato del patch: array plano de enteros, no objetos

v1 manda ops como `{op: "createElement", vid, tag}`. v2 adopta el patrón de
`SnapshotOperation` (`LYNX_PAPI_SPEC.md` §4.3): un array plano
`[opcode, ...args, opcode, ...args, ...]`, con un enum de opcodes propio
para el vocabulario mínimo de mithril-lynx (CreateElement, InsertBefore,
RemoveChild, SetAttribute, SetAttributes-batch, AddEvent, RemoveEvent).
Motivo: menos overhead de `JSON.stringify`/parseo, patrón ya probado en
producción por ReactLynx a escala. Este cambio es de bajo riesgo (es
serialización interna, no afecta la superficie pública del framework) y no
necesita spike — se implementa directo en F2.

### 3.4 Redraw automático — el rediseño central que pidió el usuario

Este es el punto que v1 nunca resolvió bien y es la razón de fondo de la
regresión activa. Diagnóstico de v1 (ya documentado en
`mithril-lynx/AGENTS.md`): el hook de fin-de-render de Mithril
(`flushTree()`) llama a un global (`__FlushElementTree`) que **a veces
existe y a veces no**, dependiendo de si `renderApp()` ya corrió, en qué
hilo, y en qué orden — un `if (typeof globalThis.X !== "function")` es una
condición de carrera de diseño, no un detalle de implementación.

**Diseño v2:** el shim de Mithril expone un **punto de extensión explícito
y obligatorio** para "algo terminó de re-renderizar, hay que empujarlo" —
no un global condicional. Ejemplo de forma (a afinar en F1, la idea es el
contrato, no la firma exacta):

```js
// v2/src/shim.js — análogo a Preact's options.__c (commit hook),
// pero como API de primera clase del shim, no un hack sobre `options`.
export function onCommit(callback) {
  // registra `callback` como EL único punto de salida de cualquier
  // pase de render/redraw — eventos, m.redraw(), aplicación de HMR.
  // Lanza si ya hay uno registrado: un shim solo tiene UN consumidor
  // (quien monta la app), nunca "el que llegue primero define el global".
}
```

`renderApp()` (el entry point de background, equivalente al `renderApp` de
v1) llama `onCommit(flushToMainThread)` **una vez, de forma explícita, en
su propio código** — no hay detección implícita de "si ya existe un
flush". Si `renderApp()` nunca corrió, cualquier intento de redraw debe
fallar ruidosamente (throw), no fallar en silencio como pasa hoy en v1
(pantalla congelada sin ningún error).

**Criterio de diseño no negociable:** todo redraw —por evento, por
`m.redraw()` manual, o por HMR— pasa por el mismo único callback. Si en
algún punto del código hace falta preguntar "¿existe la función de
flush?", el diseño está mal — la pregunta correcta es "¿ya se montó la
app?", que se responde con una excepción clara en desarrollo, no con un
`typeof` chequeado en cada llamada.

### 3.5 Los 3 modos de reload, en detalle

**A — Datos (texto/props/CSS).** Idéntico en espíritu a v1 F1: HMR normal
de webpack (`module.hot.accept("./view.js", cb)`), el callback reapunta un
binding vivo al módulo recargado y dispara un commit (§3.4). Ya validado
on-device en v1 — se re-implementa sobre el core nuevo, no se re-descubre.

**B — Estructural.** La diferencia real con A es solo "cuánto cambia el
árbol", no el mecanismo de transporte. Como en v2 la vista SIEMPRE corre en
background contra un árbol real (§3.1), un cambio estructural (nuevo nodo,
nodo eliminado, reordenado) produce naturalmente ops
`CreateElement`/`InsertBefore`/`RemoveChild` en el mismo patch — Mithril ya
sabe diffear eso, es su trabajo normal. **No hace falta un modo de wire
protocol separado como el `DEV_ONLY_AddSnapshot` de ReactLynx** (ese existe
porque ReactLynx precompila templates a nivel de función y necesita mandar
la función nueva; mithril-lynx interpreta hyperscript en runtime, así que
el módulo recargado YA contiene la nueva estructura sin nada que serializar
aparte). El problema real de B no es de protocolo — es de **reconciliación**
(§3.6): si insertás un nodo hermano de un `<input>` enfocado, ¿el input
sobrevive?

**C — Full reload.** Mecanismo de v1 sin cambios de fondo (CDP
`Page.reload`, cache-busted) — se dispara cuando `module.hot.check()` es
rechazado, `module.hot.decline()` fue llamado, o hay un error irrecuperable
aplicando un patch. Se reescribe sobre el core nuevo por prolijidad, no
porque el mecanismo esté roto.

### 3.6 Reconciliación en reload estructural — la pieza que v1 no tiene y v2 sí necesita

v1 resolvió esto para UN caso (el patrón "stable-host": un componente fijo,
delegando a un binding vivo) que preserva el `<input>` **solo si la
estructura no cambia** entre el módulo viejo y el nuevo. Eso no cubre B.

ReactLynx lo resuelve con `hydrate(oldRoot, newRoot, {skipUnRef: true})`
(`LYNX_PAPI_SPEC.md` §5.1): renderiza el árbol nuevo completo desde cero en
un root nuevo, y después reconcilia por posición/tipo contra el root viejo,
reutilizando el elemento físico donde el nodo nuevo calza estructuralmente
y creando/borrando solo donde de verdad cambió — el mismo algoritmo que se
usa para hidratar SSR, aplicado a un reload.

**Decisión para v2:** no reimplementar un hydrate genérico tipo React desde
cero (es una pieza grande y arriesgada, ver riesgos §6) — en cambio,
aprovechar que Mithril YA hace esto cuando renderiza dos veces **contra el
mismo root/vnode tree**: si el hot-update re-ejecuta `render(rootWrapper,
newVnode)` sobre el **mismo `rootWrapper`** que ya tenía el árbol viejo
montado (en vez de crear un root nuevo), el diff normal de Mithril (por
tag + posición + `key`) hace exactamente el trabajo de "reusar donde
calza, recrear donde no" — sin escribir un hydrate aparte. Esto generaliza
el patrón stable-host de v1 (que ya hacía esto para un solo componente) a
cualquier árbol, con una regla de disciplina para el autor de la app: usar
`key` en listas/nodos que puedan reordenarse, igual que en React. Se marca
como **hipótesis a verificar en F4**, no como hecho — si el diff normal de
Mithril no alcanza a preservar el foco en casos no triviales, ahí sí hace
falta diseñar algo más parecido a `hydrate()`.

### 3.7 Evitar el error "exports is not defined" por diseño, no por monkey-patch

v1 resolvió esto parcheando `lynx.requireModuleAsync` en runtime para
inyectar `module`/`exports` antes de evaluar un chunk `.hot-update.js` de
webpack. `LYNX_PAPI_SPEC.md` §6 mostró que ReactLynx nunca tiene este
problema porque **todo chunk se envuelve en build-time** en un module
system propio (`tt.define(id, function(require, module, exports, ...) {})`)
vía `RuntimeWrapperWebpackPlugin` — `module`/`exports` son siempre
parámetros de función reales, nunca variables libres que el motor deba
proveer.

**Decisión para v2 (a validar en F0.2):** escribir un plugin de build
equivalente para mithril-lynx-v2 que envuelva TODO chunk (incluidos los
`.hot-update.js`) de la misma forma, en vez de mantener el monkey-patch de
`requireModuleAsync` en el cliente de dev-reload. Si envolver hot-update
chunks specifically resulta impracticable con Rspeedy/rspack tal como está
expuesto hoy, el monkey-patch de v1 queda como plan B documentado (ya
funciona, es solo menos elegante).

### 3.8 Guard de race entre builds: contador de versión, no un flag de estado

v1 tuvo la "race de doble-build" (F1 del plan viejo): un guard
`hotStatus === "idle"` que, si dos rebuilds llegan casi juntos, degrada a
full reload aunque cada uno individualmente fuera ligero. ReactLynx evita
esto con un contador global `reloadVersion` que se incrementa en cada
reload y descarta silenciosamente cualquier patch en vuelo con una versión
vieja (`LYNX_PAPI_SPEC.md` §5.1). v2 adopta el contador de versión
directamente — no es un spike, es una decisión de bajo riesgo con un patrón
de referencia claro.

---

## 4. Fases

| Fase | Contenido | Criterio de salida | Ayuda del usuario |
|---|---|---|---|
| **F0** | Spikes de viabilidad (antes de escribir una línea del framework) | Ver F0.1–F0.3 abajo | Sí, dos de tres necesitan device |
| **F1** | Shim/core reescrito: diff de Mithril + punto de extensión de commit único (§3.4) | Test unitario equivalente al que hoy está roto en v1 (`renderer-integration.test.ts`, reescrito) **pasa desde el primer commit** | No — automatizable con `rstest` |
| **F2** | Canal de patch (según F0.1) + formato de ops plano (§3.3) + apply en main-thread | Snapshot/replay test: un render produce el mismo árbol físico que hoy, ops verificados por conteo/tipo | No |
| **F3** | Reload A (datos) + C (full) sobre el core nuevo | Device: editar texto → sin `Page.reload`, foco/texto de `<input>` intactos (mismo criterio que v1 ya alcanzó, ahora con arquitectura limpia) | Sí — device + logcat |
| **F4** | Reload B (estructural) + verificación de la hipótesis de §3.6 | Device: insertar/quitar un nodo HERMANO de un `<input>` enfocado → foco y texto sobreviven. **v1 nunca llegó a plantear este criterio** | Sí — device + logcat |
| **F5** | Verificación cruzada con Lynx DevTool | Inspeccionar el árbol de elementos en vivo durante cada uno de los 3 modos; confirmar 0 elementos huérfanos/duplicados tras reload estructural | Sí — DevTool conectado al device |
| **F6** | Empaquetado: `create-mithril-lynx-v2` (o adaptar `mithril-app-final` como banco de pruebas de v2) | Scaffold fresco compila y corre los 3 modos de reload | No (verificación automatizable una vez F0–F5 cierran) |

### F0 — Detalle de los spikes

- **F0.1 — ¿`callLepusMethod`/canal nativo directo disponible sin `@lynx-js/react`?**
  Método: app mínima en `mithril-lynx-v2` (sin ninguna dependencia de
  `@lynx-js/react`) que intente `lynx.getNativeApp().callLepusMethod(...)`
  desde el background y capturar en logcat si el main-thread recibe algo.
  Regla de decisión: ver §3.2.
- **F0.2 — ¿se puede envolver `.hot-update.js` en build-time con Rspeedy/rspack?**
  Método: plugin mínimo de rspack que intente aplicar el mismo wrapper
  `tt.define` a un chunk de hot-update generado por `HotModuleReplacementPlugin`,
  verificar en el `dist/` compilado si el wrapper quedó aplicado también ahí
  (no solo en los chunks iniciales). Regla de decisión: ver §3.7.
- **F0.3 — confirmar que el guard de `reloadVersion` alcanza sin el flag `hotStatus`.**
  Método: reproducir la race de doble-build que v1 documentó (dos rebuilds
  en ráfaga, ver `arquitectura-dual-reload.md` "race de doble-build") contra
  una implementación mínima del contador, confirmar que ambos patches se
  aplican en orden correcto (o el viejo se descarta) sin caer a full reload.

---

## 5. Herramientas de verificación ya disponibles en este entorno

- **Device Android real** (visto en sesiones anteriores: Galaxy A07 / otro
  dispositivo con Lynx Go instalado) vía `adb` — USB o Wi-Fi.
- **Lynx DevTool** (skill `lynx-devtool` + bridge ya operativo con el
  device) — inspección de árbol DOM/CSS, screenshots, logs de runtime,
  evaluación de JS en vivo.
- **`adb logcat`** — script ya existente en v1 (`mithril-app-final/scripts/adb-log.sh`),
  se replica igual en el banco de pruebas de v2.
- **`rstest`** como test runner — **no `vitest`**, ya confirmado que falla
  con "Rstest API 'describe' is not registered" si se usa por error.
- **Convención de traza `[mrl-trace]`** (o el nombre que se le dé en v2) —
  logging estructurado y numerado para diagnósticos cruzados
  background/main, ya probado como herramienta de debugging efectiva en v1.

---

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| F0.1 cierra en "no disponible para terceros" | Cae a canal de evento genérico (§3.2) — no bloqueante, ya validado en v1 |
| F0.2 impracticable con Rspeedy tal como está expuesto | Monkey-patch de v1 queda como plan B documentado, ya funciona |
| §3.6 (reusar el diff normal de Mithril como reconciliador) no alcanza en casos no triviales | F4 lo marca como hipótesis a verificar, no como hecho — si falla, hace falta una segunda iteración de diseño (hydrate real) antes de cerrar F4 |
| Sin compilador de templates, el árbol virtual es más caro en runtime que el de ReactLynx | Aceptado como no-objetivo (§2) — no se ataca en esta v2 |
| Repetir el error de v1 de dejar `console.log("[dbg]...")` de debugging mezclado con código de producción | Regla de higiene explícita: instrumentación de diagnóstico vive detrás de un flag (`__DEV__`-style), nunca como `console.log` suelto en el core |

---

## 7. Referencias

- `../../rspeedy-react-analysis/LYNX_PAPI_SPEC.md` — spec de la PAPI y
  mecanismo real de ReactLynx (fase 1 de investigación, ya escrita).
- `../../mithril-lynx/AGENTS.md` — estado y regresión activa de v1, para no
  repetir los mismos errores de diseño.
- `../../mithril-lynx/.omo/plans/arquitectura-dual-reload.md` — lo que v1
  intentó, con evidencia on-device real; insumo útil aunque v2 no siga su
  arquitectura exacta en varios puntos (§3.2–§3.8 documentan exactamente
  dónde difiere y por qué).
- `../../mithril-lynx/CONTRACT.md`, `../../mithril-lynx/DEVICE_VERIFICATION.md` —
  conceptos de Element PAPI wrapper, gestos y listas ya validados en device,
  candidatos a reimplementar (no copiar) en v2 — no forman parte del
  problema de reload, son infraestructura ya resuelta.

---

## 8. Estado de ejecución (actualizado en vivo, no re-escribir el plan de arriba)

### F0 — cerrado, con evidencia real (no experimento en device todavía, pero no hacía falta)

- **F0.1** (canal nativo sin `@lynx-js/react`): `callLepusMethod` **no existe**
  en el `lynx_core.js` real instalado (`indicadores-android/.../lynx_core.js`,
  0 ocurrencias). Sí existe `lynx.triggerLepusGlobalEvent(name, params)` —
  genérico, público, parte del motor base, no de `@lynx-js/react`. Queda
  como candidato de canal para F3; el canal de evento genérico de v1
  (`getCoreContext`/`getJSContext`, también presentes en ese mismo
  `lynx_core.js`) sigue como fallback validado si `triggerLepusGlobalEvent`
  no calza con lo que necesita v2 en la práctica.
- **F0.2** (wrapping de chunks hot-update): **causa raíz encontrada, no es
  una limitación arquitectónica.** v1 ya depende de
  `@lynx-js/runtime-wrapper-webpack-plugin` (el mismo plugin oficial que usa
  ReactLynx) pero lo configura con
  `test: new RegExp(`${name}/background\\.js$`)` (`mithril-lynx/plugin.js:613`)
  — matchea el asset inicial `main-thread/background.js` (ruta con slash,
  el nombre de ASSET) pero nunca los chunks `.hot-update.js` (que se emiten
  planos, nombrados por el nombre del CHUNK: `main-thread__background.<hash>.hot-update.js`,
  con doble guión bajo, sin slash). Confirmado con un test de regex directo,
  no con una build completa. **F6 solo necesita ampliar ese regex** —
  no hace falta un plugin nuevo ni el monkey-patch de
  `lynx.requireModuleAsync` que v1 tuvo que escribir.
- **F0.3** (guard de versión): implementado y testeado directamente
  (`src/reload/version.js` + `test/reload-version.test.ts`), sin
  necesidad de reproducir la race real todavía — la lógica es la misma que
  usa ReactLynx, de bajo riesgo.

### F1 — cerrado y verificado

Reescrito desde cero (`src/fake-dom.js`, `src/commit.js`, `src/background.js`),
corriendo el `mithril@2.3.8` real (`render/render.js`, sin fork) contra un
DOM falso construido para este propósito — no contra una copia modificada
del shim de v1. El contrato exacto de esa reimplementación está en
`mithril-lynx/CONTRACT.md` (ya escrito por una sesión anterior, verificado
por grep contra el `render.js` real) — se usó como checklist, no como
código a copiar.

**Test decisivo, verde desde el primer commit** (`test/end-to-end.test.ts`):
un `ontap` que muta estado SIN llamar `redraw()`/`m.redraw()` en ningún
lado produce un segundo patch automáticamente — el mismo escenario que
estaba en rojo en v1 (`mithril-lynx/test/renderer-integration.test.ts`,
"device regression"). La diferencia de diseño que lo logra: el callback de
redraw que Mithril llama solo (`EventDict.handleEvent`, contrato ya
documentado en CONTRACT.md §e) es una clausura capturada una vez
(`performRender` en `src/background.js`), nunca un global condicional.

### F2 — núcleo cerrado y verificado; aplicación en main-thread con un TODO explícito

`src/patch-protocol.js` (array plano de opcodes, patrón `SnapshotOperation`
de ReactLynx) + `src/backends/virtual-backend.js` (background, genera ops) +
`src/apply-patch.js` (main-thread, aplica ops con PAPI real —
`__CreateView`/`__CreateText`/`__CreateElement`/`__CreateRawText`/
`__AppendElement`/`__InsertElementBefore`/`__RemoveElement`/`__SetAttribute`/
`__SetClasses`/`__AddInlineStyle`/`__AddEventListener`/`__FlushElementTree`,
todas validadas ya en device por v1 — ver `mithril-lynx/src/lynx-mithril-shim.js`
líneas 503-519 y `CONTRACT.md`).

**Test decisivo** (`test/end-to-end.test.ts`, mismo archivo que F1): el
patch inicial y el patch del auto-redraw se aplican con el PAPI real de
`@lynx-js/testing-environment` (no un mock) y el handler del tap corre
sobre el nodo real correcto.

**Evidencia adicional para F4** (`test/structural-reload.test.ts`, no
sustituye la verificación en device pero da una señal fuerte antes de
llegar ahí): insertar un nodo hermano NUEVO junto a un nodo `input`-like
existente, ambos con `key`, **no** produce ningún op de
`CreateElement`/`RemoveChild` sobre el id del input — el diff normal de
Mithril lo reusa in-place. Confirma la hipótesis del §3.6 en el caso
keyed; el caso sin `key` NO se probó a propósito (es sabido que ahí
Mithril recrea desde el punto de la diferencia — disciplina de `key`
documentada, no bug).

**TODO explícito dejado en el código** (`apply-patch.js`, caso
`RemoveStyleProperty` con nombre `"*"`, o sea `element.style = ""`): lanza
un error en vez de fallar en silencio, porque no hay todavía una llamada
PAPI de "limpiar todos los estilos de una vez" validada. Bloqueante solo
si una app usa ese patrón exacto; no bloquea F3.

### F3–F6 — pendientes

Necesitan una app real construida contra `mithril-lynx-v2` (scaffold
nuevo o adaptar `mithril-app-final`), el fix de regex de F0.2 aplicado en
un `plugin.js` de v2 (todavía no escrito), y el device conectado
(`R8YYC0VV0PV`, confirmado disponible por `adb devices` en esta sesión)
para F3 (reload A+C), F4 (reload B + foco), F5 (DevTool). Este es el
siguiente bloque de trabajo concreto — no iniciado en esta sesión.
