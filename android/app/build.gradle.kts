plugins {
  id("com.android.application")
  kotlin("android")
  kotlin("plugin.serialization")
  kotlin("plugin.compose")
}

// 2026-04-21 FCM 接入：仅当 `android/app/google-services.json` 存在时才 apply google-services
// 插件 —— 该插件会把 JSON 中的 project_id/api_key/app_id/sender_id 生成到 values/values.xml，
// 供 FirebaseApp.initializeApp() 默认读取。缺 json 时跳过不破坏现有构建（自动降级为非 FCM
// 路径：USER_PRESENT / WorkManager 15min 周期仍生效）。
val googleServicesJson = file("google-services.json")
val hasGoogleServices = googleServicesJson.exists()
if (hasGoogleServices) {
  apply(plugin = "com.google.gms.google-services")
}

fun quoted(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

fun propertyOrEnv(name: String, envName: String, defaultValue: String): String {
  return providers.gradleProperty(name).orNull
    ?: providers.environmentVariable(envName).orNull
    ?: defaultValue
}

val applicationIdValue = propertyOrEnv(
  name = "nanoflow.android.applicationId",
  envName = "ANDROID_TWA_PACKAGE_NAME",
  defaultValue = "app.nanoflow.twa",
)

val webOrigin = propertyOrEnv(
  name = "nanoflow.webOrigin",
  envName = "NANOFLOW_WEB_ORIGIN",
  defaultValue = "https://nanoflow.pages.dev",
).trimEnd('/')

val supabaseUrl = propertyOrEnv(
  name = "nanoflow.supabaseUrl",
  envName = "NG_APP_SUPABASE_URL",
  defaultValue = "https://your-project.supabase.co",
).trimEnd('/')

val androidVersionName = propertyOrEnv(
  name = "nanoflow.android.versionName",
  envName = "ANDROID_WIDGET_VERSION_NAME",
  defaultValue = "0.1.2",
)

val widgetClientVersion = propertyOrEnv(
  name = "nanoflow.android.widgetClientVersion",
  envName = "ANDROID_WIDGET_CLIENT_VERSION",
  defaultValue = "android-widget/$androidVersionName",
)

val assetStatements = """[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"web","site":"$webOrigin"}}]"""

android {
  namespace = "app.nanoflow.host"
  compileSdk = 35

  defaultConfig {
    applicationId = applicationIdValue
    minSdk = 28
    targetSdk = 35
    versionCode = 3
    versionName = androidVersionName
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    manifestPlaceholders["nanoflowDefaultUrl"] = "$webOrigin/#/projects?entry=twa&intent=open-workspace"

    buildConfigField("String", "NANOFLOW_WEB_ORIGIN", quoted(webOrigin))
    buildConfigField("String", "NANOFLOW_SUPABASE_URL", quoted(supabaseUrl))
    buildConfigField("String", "NANOFLOW_WIDGET_PLATFORM", quoted("android-widget"))
    buildConfigField("String", "NANOFLOW_WIDGET_CLIENT_VERSION", quoted(widgetClientVersion))
    buildConfigField("String", "NANOFLOW_TWA_DEFAULT_PATH", quoted("/#/projects?entry=twa&intent=open-workspace"))
    buildConfigField("String", "NANOFLOW_TWA_FOCUS_PATH", quoted("/#/projects?entry=twa&intent=open-focus-tools"))
    buildConfigField("String", "NANOFLOW_TWA_BLACKBOX_PATH", quoted("/#/projects?entry=twa&intent=open-blackbox-recorder"))
    buildConfigField("Boolean", "NANOFLOW_FCM_ENABLED", hasGoogleServices.toString())
    resValue("string", "nanoflow_default_url", quoted("$webOrigin/#/projects?entry=twa&intent=open-workspace"))
    resValue("string", "asset_statements", quoted(assetStatements))
  }

  buildTypes {
    debug {
      isMinifyEnabled = false
    }
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  buildFeatures {
    buildConfig = true
    compose = true
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.core:core-splashscreen:1.0.1")
  implementation("androidx.activity:activity-ktx:1.10.1")
  implementation("androidx.datastore:datastore-preferences:1.1.1")
  implementation("androidx.security:security-crypto:1.1.0-alpha06")
  implementation("androidx.work:work-runtime-ktx:2.10.0")
  implementation("androidx.compose.runtime:runtime:1.7.5")
  implementation("androidx.glance:glance:1.1.1")
  implementation("androidx.glance:glance-appwidget:1.1.1")
  implementation("androidx.glance:glance-material3:1.1.1")
  implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
  implementation("com.google.firebase:firebase-messaging-ktx:24.1.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
  // 2026-04-21 FCM 接入：kotlinx-coroutines-play-services 提供 Task.await() 扩展，
  // 让 FirebaseMessaging.getInstance().token 可在 suspend 函数里直接 await。
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
  testImplementation(kotlin("test"))
}
