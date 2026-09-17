# Plan — `m.route` para mithril-lynx-v2: navegación en memoria, sin APIs de navegador

> Estado (2026-09-17): **F0–F3 hechos y verificados con `rstest` (PAPI
> real, sin mocks). F4–F6 bloqueados**: F4/F5 necesitan el device
> conectado (no lo está en este momento — `adb devices` vacío); además
> `mithril-runtime@1.1.0` (con `pathname/`/`querystring/` vendorizados)
> está pusheado a GitHub pero el `npm publish` pide un OTP que solo el
> usuario puede aprobar — mientras tanto `mithril-lynx-v2` depende de
> `file:/home/sweb/mithril-runtime` en vez de `^1.1.0`. Ver §10 al final
> para el detalle exacto.
> Idioma: español (consistente con el resto de planes de este proyecto).
> Insumo de las 3 tareas solicitadas: (1) cómo navega React en Lynx, (2)
> cómo navega Vue en Lynx, (3) diseño de nuestro propio `m.route`
> respetando la API de Mithril. Investigación vía WebSearch/WebFetch contra
> `lynxjs.org`, `vue.lynxjs.org`, y el repo `lynx-family/lynx` en GitHub —
> más lectura directa del `m.route` real en
> `node_modules/mithril/{route.js,api/router.js,pathname/}` (mithril 2.3.8,
> el mismo que `mithril-runtime` ya usa como base).

---

## 0. Por qué esto es un plan aparte (no parte del core ya construido)

`mithril-lynx-v2` (F0–F6, ya hecho y verificado en device) deliberadamente
no incluye navegación — es un no-objetivo explícito del plan original
(`mithril-lynx-v2-desde-cero.md` §2). Este documento cubre exactamente eso,
como una pieza **opcional y separada** (igual que en v1, `navigation.js`
era un export aparte, no parte del core) — nunca se mezcla con el
commit/patch/reload que ya está resuelto.

---

## 1. Tarea 1 — Cómo navega ReactLynx

**Mecanismo: React Router v6, con `MemoryRouter` (no `BrowserRouter`).**

```jsx
<MemoryRouter>
  <Routes>
    <Route path="/" element={<App />} />
    <Route path="/home" element={<Home />} />
  </Routes>
</MemoryRouter>
```

- **Por qué `MemoryRouter`**: Lynx no tiene `window.location` ni History
  API real — no hay URL bar, no hay "atrás" de navegador. `MemoryRouter`
  mantiene el historial como un array en memoria, sin ninguna dependencia
  de API de browser.
- **Navegación**: no hay `<Link>`/`<a>` (Lynx no tiene esos tags) — se usa
  el hook `useNavigate()` disparado desde un `ontap`/`bindtap`:
  ```jsx
  const nav = useNavigate();
  <text bindtap={() => nav('/home')}>Ir a Home</text>
  ```
- **Params/ubicación**: `useParams()` (segmentos dinámicos `:id`),
  `useLocation()` (pathname actual).
- **Alternativa moderna documentada**: TanStack Router, mismo motivo
  explícito: *"Memory Routing is required due to browser History API
  limitations in Lynx"*. File-based routing vía plugin de rspack
  (`@tanstack/router-plugin/rspack`) es un añadido posterior, no cambia el
  fondo (memoria, no browser).
- **Dato relevante**: hay un issue abierto y sin resolver en
  `lynx-family/lynx` (#93, *"How to navigate between pages in native
  apps?"*) preguntando específicamente por navegación "nativa" (¿bundles
  separados? ¿Activities/ViewControllers nuevos?) — **sigue sin respuesta
  oficial**. Confirma que el modelo "un solo bundle, router en memoria" es
  el único camino documentado/soportado hoy — no hay alternativa nativa
  resuelta que estemos dejando pasar.

## 2. Tarea 2 — Cómo navega Vue Lynx

**Mecanismo: Vue Router estándar, con `createMemoryHistory()`.**

```ts
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/about', name: 'about', component: About },
    { path: '/users/:id', name: 'user-detail', component: UserDetail },
  ],
});
app.use(router);
```

- **Misma razón explícita**: *"since Lynx has no browser `window.location`
  or History API, you must use `createMemoryHistory()` instead of
  `createWebHistory()"`.* Historial como array en proceso, cero
  dependencia de browser.
- **Navegación**: sin `<a>` — dos caminos: `RouterLink` con `custom` +
  scoped slot (renderiza `<view>`/`<text>` propios de Lynx, expone
  `isActive` + `navigate`), o programático vía `useRouter()` +
  `router.push()`/`.back()`/`.replace()` en un handler de tap.
- **Display**: `<RouterView>` renderiza el componente matcheado;
  `useRoute()` para params (`route.params.id`).

## 3. Patrón común extraído (la conclusión que importa para la Tarea 3)

React y Vue en Lynx **convergen exactamente en la misma arquitectura**,
independientemente del framework:

| Pieza | React en Lynx | Vue en Lynx | Conclusión para nosotros |
|---|---|---|---|
| Historial | `MemoryRouter` (array en memoria) | `createMemoryHistory()` (array en memoria) | Nuestro `m.route` NO debe tocar `window.history`/`popstate` — ninguno de los dos existe en Lynx |
| Modelo de página | Un solo bundle/página, "pantallas" = subárboles condicionales | Igual | Confirma que mithril-lynx-v2 tampoco necesita bundles separados por pantalla — un solo `renderApp()` de toda la vida de la app |
| Link/navegación | Sin `<a>`; hook + `ontap`/`bindtap` | Sin `<a>`; slot custom o hook + tap | `m.route.Link` debe re-diseñarse para emitir un elemento Lynx-nativo con `ontap`, no un `<a>` con `href`/`onclick` |
| Navegación "nativa" (multi-bundle) | Sin resolver, issue abierto sin respuesta | No mencionada | No hay un patrón oficial que estemos ignorando — el camino en-memoria es *el* camino |

---

## 4. El contrato real de `m.route` (lo que hay que igualar para que "se sienta Mithril")

Leído directo de `mithril/route.js` + `mithril/api/router.js` (2.3.8, el
mismo mithril del que sale `mithril-runtime`):

| API | Firma | Uso interno real |
|---|---|---|
| `m.route(root, defaultRoute, routes)` | monta `RouterRoot` en `root` vía `mountRedraw.mount()`, matchea rutas | `root` es un elemento DOM real — ver §5.2, esto cambia en v2 |
| `m.route.set(path, data, options)` | `pushState`/`replaceState` + `resolveRoute()` async | el `pushState` es lo único 100% browser-atado |
| `m.route.get()` | devuelve `currentPath` | puro, sin cambios |
| `m.route.prefix` | default `"#!"` | solo tiene sentido con URL real — ver §5.5 |
| `m.route.param(key)` | devuelve params de la ruta actual | puro, sin cambios |
| `m.route.Link` | componente que renderiza `<a href onclick>` | tiene que re-emitirse para Lynx — ver §5.4 |
| `m.route.SKIP` | sentinel para que `onmatch` pase a la siguiente ruta que matchee | puro, sin cambios |
| `onmatch(params, path, route)` | resolver async opcional por ruta (lazy-loading) | puro (Promise), sin cambios |

## 5. Decisiones de diseño para v2

### 5.1 Historial: array en memoria, no `window.history`/`popstate`

Un stack simple (`string[]` + índice actual) mantenido en un módulo interno
del router — exactamente lo que `MemoryRouter`/`createMemoryHistory()`
hacen por dentro. `route.set(path, data, options)` empuja o reemplaza en
ese array según `options.replace`, en vez de llamar
`history.pushState/replaceState`.

### 5.2 Mount: NO un segundo punto de montaje — `m.route` alimenta el ÚNICO `renderApp()`

Real Mithril permite (y de hecho normalmente lo hace) que `m.route()` haga
su propio `mountRedraw.mount(dom, RouterRoot)`, independiente de cualquier
otro `m.mount()` que la app tenga. **v2 no puede replicar esto tal cual**:
la arquitectura entera (plan original §3.1) es *un solo* `renderApp()` para
toda la vida de la app — dos puntos de montaje independientes romperían el
modelo de un solo commit-controller/un solo patch stream.

**Decisión**: `m.route` para v2 pierde el parámetro `root` (no hay un DOM
real al que apuntar) y en su lugar **es quien llama `renderApp()` por
vos**:

```js
// en vez de: m.route(document.body, "/", routes)  (mithril real)
import route from "mithril-lynx-v2/route";
const app = route("/", routes);           // llama renderApp() adentro, devuelve el mismo handle {redraw, document}
```

Esto es una desviación real y documentada de la firma de mithril (3
argumentos → 2), justificada porque el primer argumento nunca tuvo sentido
en Lynx (no hay nodo al que montar) — no un intento de ocultarla. Todo lo
demás (`route.set/get/param/Link/SKIP`, sintaxis de rutas con `:param`)
queda idéntico.

### 5.3 Redraw: se reusa `performRender`, no un redraw propio del router

`resolveRoute()` real llama `mountRedraw.redraw()` tras el primer mount.
Para v2, el router recibe (internamente, al llamar `renderApp()` por
dentro) la MISMA función `performRender` que ya es el único camino de
redraw de toda la app (commit.js) — no hay un segundo mecanismo de redraw
compitiendo.

### 5.4 `route.Link`: rediseño obligatorio, sin `<a>`/`onclick`

Lynx no tiene `<a>` ni `onclick`. Mirroreando el patrón de React
(`ontap={() => nav(path)}`) y Vue (scoped slot con `navigate`):

```js
route.Link = {
  view(vnode) {
    var selector = vnode.attrs.selector || "view";
    var { selector: _s, options, params, href, ...rest } = vnode.attrs;
    return hyperscript(selector, {
      ...rest,
      ontap: function (e) {
        if (rest.disabled) return;
        route.set(buildPathname(href, params), null, options);
      },
    }, vnode.children);
  },
};
```

`disabled` se respeta (igual que la versión real), pero sin
`aria-disabled`/`href=null` (conceptos de accesibilidad web sin
equivalente directo documentado en Lynx todavía — marcar como gap
conocido, no bloqueante).

### 5.5 `route.prefix`: no-op de compatibilidad

No tiene sentido sin URL bar. Se deja como una propiedad asignable que no
hace nada (para no romper código portado de mithril real que hace
`m.route.prefix = ""` defensivamente), documentado explícitamente como
ignorado.

### 5.6 `route.SKIP` / `onmatch` async: se preserva sin cambios

Es JS puro (Promises), sin acoplamiento a browser — mismo comportamiento
que mithril real, incluido lazy-loading de componentes de ruta.

### 5.7 Botón "atrás" — pregunta abierta, no asumir una respuesta

Ni React ni Vue en Lynx documentan qué pasa con un botón/gesto de "atrás"
nativo del shell (Android back, gesto iOS). Esto es un spike (F0), no una
decisión ya tomada — ver §7.

---

## 6. Qué se reutiliza sin tocar (validado, no es la parte riesgosa)

`mithril/pathname/{build.js,parse.js,compileTemplate.js}` (108 líneas
totales) — el compilador de templates de ruta (`:id`, `:file...`, etc.).
**Verificado por grep: cero referencias a `window`/`document`/`location`/
`history` en los tres archivos** — es exactamente el mismo tipo de pieza
"pura, no-browser" que ya justificó reusar `render/render.js` tal cual en
el core de v2. Se vendoriza sin modificar (mismo criterio que
`mithril-runtime`: no forkeamos algo que no está roto).

Importante: estos archivos **no están en `mithril-runtime`** — el script
de extracción nunca los copió (no estaban en el allowlist de
`update-from-mithril.sh`). Hay que agregarlos ahí (a `mithril-runtime`,
como una pieza más del "runtime puro sin browser") o vendorizarlos
directo en `mithril-lynx-v2/route.js` — decisión de F1.

---

## 7. Fases

| Fase | Contenido | Criterio de salida | Device |
|---|---|---|---|
| **F0** | Spike: ¿Lynx expone un evento nativo de "back" (hardware/gesto) al hilo background? Revisar `lynx.getEngine()`/`lynx.getCoreContext()` en busca de un evento de lifecycle equivalente a `popstate`, probar en el device ya conectado. | Respuesta documentada con evidencia (logcat), no supuesta | Sí |
| **F1** | Vendorizar `pathname/*` (¿en `mithril-runtime` o directo en `mithril-lynx-v2`? decidir acá) + historial en memoria (array + índice) + `route.set/get/param/SKIP` sobre ese historial | Tests `rstest`: matching de `:param`, push/replace, `route.get()` correcto — sin device | No |
| **F2** | Integrar con `renderApp()`: `m.route(defaultRoute, routes)` como único punto de entrada, sin segundo mount | Test: navegar entre 2 rutas produce los ops de patch esperados (crear árbol nuevo, no acumular el viejo) | No |
| **F3** | `route.Link` rediseñado (`ontap`, sin `<a>`) | Test: tap en un Link navega, `disabled` bloquea el tap | No |
| **F4** | Verificación en device: navegar 2+ pantallas reales, confirmar con `uiautomator`/DevTool que la pantalla vieja se desmonta (sin huérfanos) | uiautomator/CDP tree limpio en cada paso | Sí |
| **F5** | Atrás nativo (según lo que F0 haya encontrado) — si existe evento, engancharlo a `route.set` con `replace`; si no existe, documentar que no hay atrás nativo y `route.Link`/botón explícito es el único camino | Depende de F0 | Sí |
| **F6** | Interacción con reload (A/B ya construidos): ¿cambiar de ruta durante un hot-update de datos/estructural sigue funcionando sin recrear todo el árbol? | Test + verificación en device combinando ambos | Sí |

---

## 8. No-objetivos

- Historial persistente entre reinicios de la app (un `Page.reload`/full
  reload ya resetea todo — no se intenta preservar la ruta a través de
  eso en esta fase).
- `route.prefix` funcional (hash o pathname reales) — no tiene sentido sin
  URL bar; queda como no-op documentado (§5.5).
- Deep-linking (abrir la app directo en una ruta interna desde afuera) —
  fuera de alcance, es un tema de intents/schemes nativos, no del router
  en sí.

---

## 9. Referencias

- ReactLynx routing: <https://lynxjs.org/react/routing/react-router>,
  <https://lynxjs.org/4.0/react/routing/tanstack-router>
- Vue Lynx routing: <https://vue.lynxjs.org/guide/routing>
- Issue sin resolver sobre navegación nativa:
  <https://github.com/lynx-family/lynx/issues/93>
- Contrato real de `m.route`: `node_modules/mithril/route.js`,
  `node_modules/mithril/api/router.js`,
  `node_modules/mithril/pathname/{build,parse,compileTemplate}.js`
  (mithril 2.3.8 — mismo checkout que ya usa `mithril-runtime`).
- Arquitectura base sobre la que esto se integra:
  `mithril-lynx-v2-desde-cero.md` (especialmente §3.1, un solo
  `renderApp()`, y §3.4, el único punto de commit/redraw).

---

## 10. Estado de ejecución

### F0 — respuesta parcial (estático, no en device)

`grep` sobre `lynx_core.js` instalado (indicadores-android) y el runtime
de ReactLynx (`@lynx-js/react`) no encontró **ningún** evento de "back"
nativo/hardware expuesto al hilo JS — solo `onAppEnterBackground`
(ciclo de vida de la app, no navegación). Consistente con que ni
`MemoryRouter` ni `createMemoryHistory()` escuchan algo así. **No
confirmado en vivo** — el device no estaba conectado en esta sesión.
`route.back()`/`route.forward()` ya están implementados sobre el stack en
memoria (§5.1); si F4 en device confirma que SÍ existe un evento nativo,
conectarlo a `route.back()` es trivial.

### F1–F3 — cerrados, verificados con `rstest` (5 tests nuevos, PAPI real)

- **`mithril-runtime@1.1.0`**: se agregaron `pathname/{build,parse,
  compileTemplate}.js` + `querystring/{build,parse}.js`, copiados sin
  modificar desde mithril 2.3.8 (verificado: cero referencias a
  `window`/`document`/`location`/`history`). `update-from-mithril.sh`
  actualizado para seguir sincronizándolos. Commiteado y pusheado a
  GitHub (`5e35bd2`); **`npm publish` pendiente del OTP del usuario**.
- **`src/route.js`** (mithril-lynx-v2): implementado siguiendo §5
  completo — historial en memoria, `route(defaultRoute, routes)` sin
  parámetro `root` (llama `renderApp()` adentro, una sola vez, mismo
  patrón `hasBeenResolved` que el `api/router.js` real), `route.set/get/
  param/SKIP` idénticos en comportamiento a mithril real, `onmatch`
  async preservado, `route.Link` reescrito con `ontap` (sin `<a>`/
  `onclick`), `route.prefix` no-op documentado, y `route.back()/
  forward()` nuevos (no existen en mithril real — necesarios porque acá
  no hay botón de navegador que dispare `popstate`).
- **`test/route.test.ts`** (5 tests, todos contra PAPI real vía
  `@lynx-js/testing-environment`, mismo patrón que
  `test/end-to-end.test.ts`): ruta por defecto + `get()`/`param()`;
  navegación sin nodos huérfanos (ops de `RemoveChild`+`CreateElement`
  confirmados); `back()`/`forward()` sobre el stack; `onmatch`+`SKIP`
  cayendo a la siguiente ruta; `Link` navegando por tap y respetando
  `disabled`. **Los 8 tests de la suite completa pasan** (los 3 de antes
  + estos 5).
- **Deviación respecto al plan original**: el plan (§5.2) proponía que
  `m.route(...)` devolviera el handle `{redraw, document}` de
  `renderApp()`. Al implementarlo se decidió NO devolver nada (igual que
  el `m.route()` real, que tampoco devuelve algo útil) — el auto-redraw
  de Mithril ya cubre todos los redraws necesarios sin que el código de
  la app necesite tocar `app.redraw()`/`app.document` directamente. Más
  fiel a "se siente Mithril" que la propuesta original.
- **Dependencia temporal**: mientras `mithril-runtime@1.1.0` no esté en
  npm, `mithril-lynx-v2/package.json` apunta a
  `file:/home/sweb/mithril-runtime` en vez de `^1.1.0` — cambiar en
  cuanto el publish se complete (mismo procedimiento que la vez pasada
  con 1.0.0).

### F4–F6 — pendientes, bloqueados por el device

No se pudo verificar en device real esta sesión (`adb devices` no listó
ningún device conectado). Falta: navegar entre 2+ pantallas reales y
confirmar árbol limpio con `uiautomator`/DevTool (F4); confirmar o
descartar en vivo el hallazgo estático de F0 sobre el botón atrás (F5);
probar reload (A/B) combinado con una ruta activa (F6). Reconectar el
device y correr esto es el siguiente paso concreto.
