# Guía: crear una APK Android para una app mithril-lynx, desde cero, por línea de comandos

Esta guía documenta el procedimiento completo, real y reproducible que usa
este proyecto (verificado en `mithril-lynx-ui/demo` + `demo-android`, y en
`indicadores-android` para el hack de fuentes) para:

1. Crear el proyecto JS que compila a un bundle Lynx (`mithril-lynx` + `rspeedy`).
2. Crear el host Android **desde cero, sin Android Studio**, solo con Gradle CLI.
3. Conectar el bundle compilado (`.bundle`) a la APK.
4. Compilar e instalar la APK por línea de comandos con `adb`.
5. Aplicar el hack de prefetch de fuentes `.ttf` para evitar el cold-start
   lento de `@font-face` en Lynx (bug real, documentado en
   [lynx-family/lynx#9431](https://github.com/lynx-family/lynx/issues/9431)).

Todo lo mostrado aquí es código real, tomado de proyectos ya funcionando y
verificados en dispositivo (`mithril-lynx-ui/demo-android`,
`indicadores-android`) — no es un tutorial genérico inventado.

---

## 0. Prerrequisitos

| Herramienta | Versión usada en este proyecto | Notas |
|---|---|---|
| Node.js | `^20.19.0` o `>=22.12.0` | requerido por `@lynx-js/rspeedy` |
| JDK | 17 (Temurin) | `sourceCompatibility`/`targetCompatibility` = 17 |
| Android SDK (cmdline-tools) | platform `android-34`, build-tools `34.0.0` | sin Android Studio, solo el SDK |
| `adb` | el que trae `platform-tools` | para instalar/lanzar en un dispositivo o emulador |

Instalar el Android SDK **solo con línea de comandos** (sin Android Studio):

```bash
# 1. Descargar los "command line tools" desde
#    https://developer.android.com/studio#command-tools
mkdir -p ~/android-sdk/cmdline-tools
unzip commandlinetools-linux-*.zip -d ~/android-sdk/cmdline-tools
mv ~/android-sdk/cmdline-tools/cmdline-tools ~/android-sdk/cmdline-tools/latest

export ANDROID_HOME=~/android-sdk
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"

# 2. Instalar exactamente lo necesario para compilar (acepta licencias primero)
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

Con eso ya tienes `adb`, `platforms/android-34` y `build-tools/34.0.0` —
suficiente para compilar y firmar una APK debug sin instalar el IDE.

---

## 1. Parte A — El proyecto JS (mithril-lynx + rspeedy)

Esta parte produce el artefacto real que la APK necesita: un archivo
`.bundle` (código Lepus/main-thread + JS de background, empaquetados
juntos por `mithril-lynx/plugin`).

### 1.1 `package.json`

```json
{
  "name": "mi-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "rspeedy dev",
    "build": "rspeedy build"
  },
  "dependencies": {
    "mithril": "2.3.8",
    "mithril-lynx": "^0.0.6"
  },
  "devDependencies": {
    "@lynx-js/config-rsbuild-plugin": "^0.2.3",
    "@lynx-js/rspeedy": "^0.17.0",
    "@lynx-js/types": "4.1.0",
    "@rsbuild/plugin-type-check": "^1.6.0",
    "@types/mithril": "^2.2.9",
    "typescript": "~5.9.0"
  },
  "engines": {
    "node": "^20.19.0 || >=22.12.0"
  }
}
```

`mithril-lynx` es el shim que hace que Mithril (el framework de 2.3.8)
renderice contra los elementos nativos de Lynx en vez del DOM. Trae varios
subpaths útiles (`mithril-lynx/plugin`, `mithril-lynx/main-thread`,
`mithril-lynx/gesture`, `mithril-lynx/element`, `mithril-lynx/list`,
`mithril-lynx/navigation`, `mithril-lynx/testing`).

Si además quieres componentes ya hechos (Button, Dialog, Sheet, Popover,
layout, etc.), agrega `mithril-lynx-ui` (o, mientras desarrollas la propia
librería en paralelo, un `"mithril-lynx-ui": "file:../ruta/a/mithril-lynx-ui"`
como hace `mithril-lynx-ui/demo`).

```bash
npm install
```

### 1.2 `lynx.config.ts` (configuración de `rspeedy`)

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pluginLynxConfig } from "@lynx-js/config-rsbuild-plugin";
import { defineConfig } from "@lynx-js/rspeedy";
import { pluginTypeCheck } from "@rsbuild/plugin-type-check";

import { pluginMithrilLynx } from "mithril-lynx/plugin";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  source: {
    entry: {
      "main-thread": path.join(projectRoot, "src/main-thread.ts"),
    },
  },
  output: {
    distPath: { root: path.join(projectRoot, "dist") },
    filename: "[name].bundle",
  },
  plugins: [
    pluginMithrilLynx(),
    // Sin esto, __SetGestureDetector() (createGesture() de
    // mithril-lynx/gesture, usado por cualquier componente con drag/swipe)
    // se registra pero el runtime nunca actúa sobre él — el motor sigue
    // usando el camino legado "solo touch". Necesario desde que uses
    // cualquier gesto nativo.
    pluginLynxConfig({ enableNewGesture: true }),
    pluginTypeCheck(),
  ],
});
```

`pluginMithrilLynx()` hace que `rspack` procese **un solo `style.css` por
carpeta de entry** a través del pipeline CSS normal — por eso
`@import "mithril-lynx-ui/styles.css";` (o cualquier otro `@import`) se
resuelve igual que cualquier import de `node_modules`.

### 1.3 El entry point

`src/main-thread.ts` — este es el que declara `lynx.config.ts` como
`entry`, y es el que arranca el runtime de mithril-lynx:

```ts
import { setupApp } from "mithril-lynx/main-thread";
import app from "./index.js";

// Sin background.ts que sincronizar, enableBackgroundSync:false evita que
// setupApp() intente abrir un canal hacia un bundle de background que no
// existe. Si tu app SÍ hace fetch/lógica en background, déjalo en true (o
// simplemente omítelo) y crea src/background.ts.
setupApp({ root: app.root, enableBackgroundSync: false });
```

`src/index.ts` — tu app Mithril normal, usando elementos Lynx (`view`,
`text`, etc.) en vez de HTML:

```ts
import m from "mithril";

const Root = {
  view: () =>
    m("view", { class: "Page" }, [
      m("text", { class: "Title" }, "Hola desde mithril-lynx"),
    ]),
};

export default { Root, root: () => m(Root) };
```

`src/style.css`:

```css
.Page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
}
```

`src/rspeedy-env.d.ts` (tipos de ambiente, solo TypeScript):

```ts
/// <reference types="@lynx-js/rspeedy/client" />
/// <reference types="@lynx-js/types" />
```

### 1.4 Compilar el bundle

```bash
npm run build
```

Esto genera `dist/main-thread.bundle` — un único archivo binario que
contiene TANTO el código main-thread (Lepus) COMO el de background (JS),
codificados juntos. Es este archivo el que la APK necesita empaquetar.

---

## 2. Parte B — El proyecto Android, desde cero, solo con Gradle CLI

Ninguno de estos pasos necesita Android Studio — todo se hace con archivos
de texto y `./gradlew` desde la terminal.

### 2.1 Estructura de carpetas

```
mi-app-android/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties
├── local.properties
├── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle.kts
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/                      ← aquí va el .bundle
        ├── java/com/miapp/
        │   ├── MiApp.kt                 ← Application
        │   ├── MainActivity.kt
        │   └── AssetTemplateProvider.kt
        └── res/
            ├── values/strings.xml
            ├── values/themes.xml
            ├── drawable/ic_launcher_background.xml
            ├── drawable/ic_launcher_foreground.xml
            └── mipmap-anydpi-v26/ic_launcher.xml
```

```bash
mkdir -p mi-app-android/app/src/main/{assets,java/com/miapp,res/values,res/drawable,res/mipmap-anydpi-v26}
mkdir -p mi-app-android/gradle/wrapper
```

### 2.2 `settings.gradle.kts` (raíz)

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mi-app-android"
include(":app")
```

### 2.3 `build.gradle.kts` (raíz)

```kotlin
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
```

### 2.4 `gradle.properties`

```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
```

### 2.5 `local.properties`

```properties
sdk.dir=/ruta/a/tu/android-sdk
```

### 2.6 El Gradle Wrapper (sin Android Studio)

Si ya tienes Gradle instalado en algún lado (o `sdkmanager` no lo trae),
genera el wrapper directamente:

```bash
cd mi-app-android
gradle wrapper --gradle-version 8.14.2
```

Esto crea `gradlew`, `gradlew.bat` y
`gradle/wrapper/gradle-wrapper.properties`. Si no tienes Gradle instalado
localmente, puedes escribir `gradle-wrapper.properties` a mano y Gradle
descargará el `.jar` del wrapper la primera vez que corras `./gradlew`:

```properties
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.14.2-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
```

(en ese caso también necesitas los archivos `gradlew`/`gradlew.bat` y
`gradle/wrapper/gradle-wrapper.jar`, que puedes copiar de cualquier
proyecto Gradle existente o generar una vez con `gradle wrapper` en
cualquier máquina que sí tenga Gradle).

### 2.7 `app/build.gradle.kts` — las dependencias reales de Lynx

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.miapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.miapp"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // El artefacto core — LynxView, LynxViewBuilder, el motor de layout, etc.
    implementation("org.lynxsdk.lynx:lynx:4.1.0")

    // OPT-IN, agrégalos solo si los usas:

    // <input>/<textarea> — sin esto, esos elementos ocupan tamaño 0 y
    // nunca abren el teclado. No forman parte del artefacto core.
    implementation("org.lynxsdk.lynx:xelement:4.1.0")
    implementation("org.lynxsdk.lynx:xelement-input:4.1.0")

    // <overlay> — sin esto, el elemento monta sin error pero nunca se ve
    // (Dialog/Sheet/Popover en mithril-lynx-ui lo necesitan).
    implementation("org.lynxsdk.lynx:xelement-overlay:4.1.0")

    // Sin un ILynxLogService registrado, console.log() y los errores de JS
    // del bundle se pierden en silencio — ni logcat los muestra.
    implementation("org.lynxsdk.lynx:lynx-service-log:4.1.0")

    // <refresh> (pull-to-refresh, dentro del artefacto xelement) depende
    // internamente de SmartRefreshLayout, cuyo código de touch-dispatch
    // referencia ViewPager2 aunque no lo uses — sin esto, cada touch sobre
    // un <refresh> lanza NoClassDefFoundError (silencioso, el motor Lynx lo
    // atrapa, pero el gesto de refresh simplemente no funciona nunca).
    implementation("androidx.viewpager2:viewpager2:1.1.0")

    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
}
```

### 2.8 `AndroidManifest.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:name=".MiApp"
        android:allowBackup="true"
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:hardwareAccelerated="true"
        android:usesCleartextTraffic="true"
        android:theme="@style/AppTheme">

        <activity
            android:name=".MainActivity"
            android:theme="@style/Theme.App.Starting"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

    </application>

</manifest>
```

### 2.9 Recursos mínimos para que compile

`res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">Mi App</string>
</resources>
```

`res/values/themes.xml`:

```xml
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar" />

    <style name="Theme.App.Starting" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">#0F1115</item>
        <item name="postSplashScreenTheme">@style/AppTheme</item>
    </style>
</resources>
```

`res/mipmap-anydpi-v26/ic_launcher.xml` (icono adaptativo mínimo):

```xml
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
```

`res/drawable/ic_launcher_background.xml` (un color plano sirve):

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z" android:fillColor="#0F1115" />
</vector>
```

`res/drawable/ic_launcher_foreground.xml` (cualquier vector simple):

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path
        android:pathData="M30,54 L50,74 L78,34"
        android:strokeColor="#6EE7B7"
        android:strokeWidth="6"
        android:strokeLineCap="round"
        android:strokeLineJoin="round" />
</vector>
```

(también necesitas `mipmap-anydpi-v26/ic_launcher_round.xml`, idéntico al
`ic_launcher.xml` de arriba).

### 2.10 `MiApp.kt` — la clase `Application`

```kotlin
package com.miapp

import android.app.Application
import com.lynx.service.log.LynxLogService
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.service.LynxServiceCenter

class MiApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Registra el servicio de log ANTES de LynxEnv.inst().init() — sin
        // esto, console.log() y los errores JS del bundle no aparecen ni en
        // logcat. Quítalo en una build de producción si no lo necesitas.
        LynxServiceCenter.inst().registerService(LynxLogService)
        LynxLogService.switchLogToSystem(true)

        LynxEnv.inst().init(this, null, null, null)
    }
}
```

### 2.11 `AssetTemplateProvider.kt` — leer el bundle SIN bloquear el hilo UI

```kotlin
package com.miapp

import android.content.Context
import com.lynx.tasm.provider.AbsTemplateProvider
import java.io.IOException

// Lee el bundle en un hilo aparte. Medido en un dispositivo real: leer el
// mismo asset SÍNCRONAMENTE en MainActivity.onCreate() (bloqueando el hilo
// UI de Android — distinto del split main/background thread interno de
// Lynx, pero igual de dañino para el primer frame) costó 2.4-2.8s de cold
// start; con este provider asíncrono, ~300ms.
class AssetTemplateProvider(private val context: Context) : AbsTemplateProvider() {
    override fun loadTemplate(url: String, callback: Callback) {
        Thread {
            try {
                val bytes = context.assets.open(url).use { it.readBytes() }
                callback.onSuccess(bytes)
            } catch (e: IOException) {
                callback.onFailed(e.toString())
            }
        }.start()
    }
}
```

### 2.12 `MainActivity.kt` — montar el `LynxView`

```kotlin
package com.miapp

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.ThreadStrategyForRendering

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Debe llamarse ANTES de super.onCreate() — es un requisito de la
        // Splash Screen API.
        installSplashScreen()
        super.onCreate(savedInstanceState)

        val builder = LynxViewBuilder()
        // Si usas <input>/<textarea>, también:
        // builder.addBehaviors(com.lynx.xelement.XElementBehaviors().create())
        builder.setThreadStrategyForRendering(ThreadStrategyForRendering.ALL_ON_UI)
        builder.setTemplateProvider(AssetTemplateProvider(this))
        val lynxView = builder.build(this)
        setContentView(lynxView)

        // "main-thread.bundle" debe existir en app/src/main/assets/ — ver
        // la sección 3 de esta guía.
        lynxView.renderTemplateUrl("main-thread.bundle", "")
    }
}
```

---

## 3. Parte C — Conectar el bundle JS a la APK

Este es el paso que une las dos partes anteriores: el `.bundle` que generó
`rspeedy` (Parte A) tiene que terminar dentro de
`app/src/main/assets/` (Parte B) **con el mismo nombre** que le pasas a
`renderTemplateUrl(...)`.

```bash
# 1. Compilar el bundle JS
npm --prefix mi-app-js run build

# 2. Copiarlo a los assets de Android (mismo nombre que renderTemplateUrl)
mkdir -p mi-app-android/app/src/main/assets
cp mi-app-js/dist/main-thread.bundle mi-app-android/app/src/main/assets/main-thread.bundle

# 3. Compilar e instalar la APK debug en el dispositivo/emulador conectado
cd mi-app-android
./gradlew installDebug

# 4. Lanzarla
adb shell am force-stop com.miapp
adb shell am start -W -n com.miapp/.MainActivity
```

`./gradlew installDebug` compila `app-debug.apk` (con la
`debug.keystore` autogenerada por AGP, firma automática) y la instala
directo en el dispositivo conectado — no hace falta pasar por `adb install`
a mano, aunque también funciona:

```bash
./gradlew assembleDebug   # solo compila, no instala
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 3.1 Script todo-en-uno

Así es como este mismo proyecto encadena los 4 pasos en un solo comando
(`mithril-lynx-ui/demo.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

npm --prefix mi-app-js run build
mkdir -p mi-app-android/app/src/main/assets
cp mi-app-js/dist/main-thread.bundle mi-app-android/app/src/main/assets/main-thread.bundle

(cd mi-app-android && ./gradlew --quiet installDebug)

adb shell am force-stop com.miapp
adb shell am start -W -n com.miapp/.MainActivity | grep -E "TotalTime|LaunchState"
```

`am start -W` bloquea hasta que la Activity termina de dibujar su primer
frame e imprime `TotalTime`/`WaitTime` — la forma real de medir cold start
desde línea de comandos, sin instrumentación adicional.

### 3.2 APK de release (firmada)

```bash
# Generar un keystore (una sola vez)
keytool -genkey -v -keystore release.keystore -alias mi-app \
  -keyalg RSA -keysize 2048 -validity 10000

# En app/build.gradle.kts, dentro de android { }:
#   signingConfigs {
#       create("release") {
#           storeFile = file("../release.keystore")
#           storePassword = System.getenv("KEYSTORE_PASSWORD")
#           keyAlias = "mi-app"
#           keyPassword = System.getenv("KEY_PASSWORD")
#       }
#   }
#   buildTypes {
#       release {
#           signingConfig = signingConfigs.getByName("release")
#           isMinifyEnabled = true
#       }
#   }

KEYSTORE_PASSWORD=... KEY_PASSWORD=... ./gradlew assembleRelease
# APK final: app/build/outputs/apk/release/app-release.apk
```

---

## 4. Parte D — El hack de fuentes `.ttf` (`@font-face` prefetch)

### 4.1 El problema

Un `@font-face` personalizado en Lynx (confirmado en
`org.lynxsdk.lynx:lynx:4.1.0`, y también reproducido en ReactLynx — no es
un bug de mithril-lynx) se resuelve **sincrónicamente dentro de la primera
llamada nativa a `__FlushElementTree()`**, y ese costo escala con cuántos
nodos de texto terminan resolviendo esa familia tipográfica — hasta +2s de
cold start medidos en un dispositivo gama media/baja (Samsung Galaxy A07)
aplicando la fuente a un simple selector `text { font-family: ...; }`.

Reportado upstream:
[lynx-family/lynx#9431](https://github.com/lynx-family/lynx/issues/9431).

**La solución**: en vez de dejar que `@font-face` se resuelva la primera
vez que el layout la necesita, *precalentar* (`prefetch`) el `Typeface`
desde Kotlin, **antes** de que `renderTemplateUrl()` siquiera arranque el
bundle — así cuando el CSS real pide esa fuente durante el primer layout,
ya está en caché y la resolución es instantánea.

Medido en el mismo dispositivo, con la fuente aplicada al selector más
amplio posible (`text { font-family: ...; }`, cada nodo de texto): de
~1.4-2.9s bajó a **~750-800ms — indistinguible del baseline sin fuente
personalizada.**

### 4.2 Paso 1 — el `.ttf` va en `assets/fonts/`

```bash
mkdir -p app/src/main/assets/fonts
cp ubuntu_mono.ttf app/src/main/assets/fonts/ubuntu_mono.ttf
```

### 4.3 Paso 2 — declarar `@font-face` con `asset:///` en tu CSS

En el `style.css` del proyecto **JS** (el mismo `@import`ado por
`lynx.config.ts`), no en el Android:

```css
@font-face {
  font-family: "Ubuntu Mono";
  src: url("asset:///fonts/ubuntu_mono.ttf");
}

text {
  font-family: "Ubuntu Mono", sans-serif;
}
```

El string `asset:///fonts/ubuntu_mono.ttf` tiene que ser **byte por byte
idéntico** al que usarás en `prefetchFont()` (paso 4.5) — Lynx cachea el
`Typeface` prefetcheado usando ese string exacto como llave.

### 4.4 Paso 3 — registrar un `LynxFontFaceLoader.Loader` que sepa resolver `asset:///`

El loader por defecto de Lynx (decompilado de `lynx-4.1.0.aar`) **no
resuelve `asset:///` de ninguna forma** — ni para el prefetch ni para la
resolución real — a menos que registres el tuyo:

```kotlin
package com.miapp

import android.graphics.Typeface
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.fontface.FontFace
import com.lynx.tasm.loader.LynxFontFaceLoader

object AssetFontFaceLoader : LynxFontFaceLoader.Loader() {
    private const val ASSET_PREFIX = "asset:///"

    override fun onLoadFontFace(
        context: LynxContext,
        type: FontFace.TYPE,
        src: String,
    ): Typeface? {
        if (!src.startsWith(ASSET_PREFIX)) return null
        return try {
            Typeface.createFromAsset(context.context.assets, src.removePrefix(ASSET_PREFIX))
        } catch (e: Exception) {
            null
        }
    }
}
```

### 4.5 Paso 4 — registrar el loader ANTES de `LynxEnv.inst().init()`

En tu `Application.onCreate()` (`MiApp.kt` de la sección 2.10):

```kotlin
class MiApp : Application() {
    override fun onCreate() {
        super.onCreate()

        LynxServiceCenter.inst().registerService(LynxLogService)
        LynxLogService.switchLogToSystem(true)

        // DEBE ir antes de LynxEnv.inst().init() — es lo que hace que
        // "asset:///" sea resolvible, tanto por el prefetch como por la
        // resolución real de @font-face.
        LynxFontFaceLoader.setLoader(AssetFontFaceLoader)

        LynxEnv.inst().init(this, null, null, null)
    }
}
```

### 4.6 Paso 5 — `prefetchFont()` ANTES de `renderTemplateUrl()`

En `MainActivity.kt`, justo después de `builder.build(this)` y ANTES de
`lynxView.renderTemplateUrl(...)`:

```kotlin
import com.lynx.tasm.fontface.FontFaceManager

// ...
val lynxView = builder.build(this)
setContentView(lynxView)

FontFaceManager.getInstance().prefetchFont(
    lynxView.lynxContext,
    "asset:///fonts/ubuntu_mono.ttf",   // idéntico al src: url(...) del CSS
    null,
    object : FontFaceManager.FontFacePrefetchListener {
        override fun onComplete(code: Int, msg: String) {}
    },
)

lynxView.renderTemplateUrl("main-thread.bundle", "")
```

`prefetchFont()` corre en el pool de hilos IO propio de Lynx — no bloquea
nada. Si la carrera contra el primer layout se gana (lo normal, dado que el
JS del bundle todavía ni siquiera empezó a ejecutarse), no hay flash visible
de fuente fallback; si por algún motivo se pierde, simplemente se degrada al
comportamiento normal (la fuente se resuelve donde siempre, sin romper
nada).

### 4.7 Por qué este camino y no las APIs de JS documentadas

Lynx documenta `lynx.addFont()` y
`lynx.requestResourcePrefetch({type:"font"})`, ambas llamables desde JS.
**No sirven para este problema**: se invocan desde un hook post-mount, es
decir, el motor ya tiene que estar arrancado y corriendo para que cualquiera
de las dos dispare — no pueden ganar la carrera del *primer* frame. Además,
todos los ejemplos oficiales apuntan a una fuente servida por HTTPS, nunca a
un asset local empaquetado.

El camino nativo (Kotlin) corre **antes de que el motor JS siquiera
arranque**, así que no hay ventana en la que se vea el fallback.

**Trade-off a tener presente**: `FontFaceManager`/`LynxFontFaceLoader` son
clases públicas (no `@RestrictTo`) pero no están documentadas para este uso
específico — podrían cambiar sin aviso en una futura versión mayor del SDK
de Lynx, a diferencia de la superficie de API JS oficial.

---

## 5. Cheatsheet — comandos de referencia rápida

```bash
# Compilar el bundle JS
npm --prefix mi-app-js run build

# Copiarlo a Android
cp mi-app-js/dist/main-thread.bundle mi-app-android/app/src/main/assets/main-thread.bundle

# Compilar + instalar en el dispositivo conectado
(cd mi-app-android && ./gradlew installDebug)

# Reiniciar y medir cold start
adb shell am force-stop com.miapp
adb shell am start -W -n com.miapp/.MainActivity

# Ver logs en vivo (requiere LynxLogService registrado, ver 2.10)
adb logcat | grep -i lynx

# Solo compilar el APK sin instalar
(cd mi-app-android && ./gradlew assembleDebug)
# → mi-app-android/app/build/outputs/apk/debug/app-debug.apk

# Limpiar el build (por si algo quedó en un estado raro)
(cd mi-app-android && ./gradlew clean)

# Ver qué dispositivos/emuladores hay conectados
adb devices -l
```

---

## 6. Problemas comunes (troubleshooting)

| Síntoma | Causa | Solución |
|---|---|---|
| `<input>`/`<textarea>` ocupan tamaño 0, nunca abren teclado | Falta `xelement`/`xelement-input`, o falta `builder.addBehaviors(XElementBehaviors().create())` | Sección 2.7 y 2.12 |
| `<overlay>` monta pero nunca se ve nada | Falta `xelement-overlay` | Sección 2.7 |
| Un gesto (`createGesture()`, drag/swipe) no dispara ningún callback, sin error | Falta `pluginLynxConfig({ enableNewGesture: true })` en `lynx.config.ts` | Sección 1.2 |
| `console.log()` / errores JS no aparecen en ningún lado | Falta `lynx-service-log` + `LynxServiceCenter.inst().registerService(LynxLogService)` | Sección 2.7 y 2.10 |
| Tocar un `<refresh>` lanza `NoClassDefFoundError` (atrapado, el gesto simplemente no anda) | Falta `androidx.viewpager2:viewpager2` | Sección 2.7 |
| Cold start de 2+ segundos | Bundle leído sincrónicamente en el hilo UI | Usar `AssetTemplateProvider` async (sección 2.11), nunca `context.assets.open(...)` directo en `onCreate()` |
| `@font-face` personalizado agrega +1-2s de cold start | Resolución síncrona dentro de `__FlushElementTree()` — bug conocido | Parte D completa |
| `asset:///...` no resuelve ni con `prefetchFont()` ni en el CSS real | Falta `LynxFontFaceLoader.setLoader(...)`, o se registró después de `LynxEnv.inst().init()` | Sección 4.5 |
| `./gradlew` falla con "SDK location not found" | Falta `local.properties` con `sdk.dir=...` | Sección 2.5 |
| Error de licencias del SDK al compilar | Licencias no aceptadas | `yes \| sdkmanager --licenses` |
