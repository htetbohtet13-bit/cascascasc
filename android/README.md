# ကျွဲဂိမ်း777 Android WebView

Small native Android app for **https://www.j777ml.com/**, using the supplied buffalo logo.
App name: **ကျွဲဂိမ်း777**. Package: `com.j777ml.app`; version: `1.0.3` (code 4); Android 8.0 or newer.
This is a signed APK for direct installation, not a Play Store submission.

## Features

- Website fills the app, with Burmese loading and connection/retry messages.
- Persistent first-party cookies and web storage keep the website session.
- A `J777App/1.0.3` user-agent marker lets the website hide its app download button inside this app.
- Standard PNG launcher icons at five densities, plus adaptive icons and a 777 themed icon.
  The exact uploaded artwork is kept in `branding/app-icon.png`; `prepare-icons.ps1`
  exports Android sizes without changing the artwork.
- Android back navigates web history; at the first page it asks before exiting.
- Game/provider HTTPS pages open inside the app, with a small home button and visible hostname.
- Touch-initiated telephone, email, Telegram and Viber links open their installed apps.
- HTTPS only; certificate errors are never bypassed. Local files, content providers,
  mixed HTTP content, native JavaScript bridges, camera/microphone/location permissions,
  third-party cookies, release debugging, and app backups are disabled.
- No payment API changes, stored server secrets, automatic payment retries, or analytics SDK.
- Website changes appear immediately without rebuilding the APK. Internet access is required.

## Build on Windows

Requires JDK 17, Android SDK platform 36 and build-tools 35.0.0. Set `JAVA_HOME`
and `ANDROID_HOME`, or the script can locate existing Bubblewrap tools / Android SDK.

First build only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\android\build-apk.ps1 -InitializeSigning
```

Later builds:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\android\build-apk.ps1
```

The script runs navigation unit tests, Android release lint, builds and signs the
release APK, verifies its signature and copies it to `artifacts/J777-v1.0.3.apk`.
Gradle wrapper downloads are checksum verified. Signing files and generated outputs
are ignored by Git. No existing web or server build settings are changed.

**Back up both `android/.signing/j777-release.jks` and `android/keystore.properties`
in private storage.** The same signing key is required for future in-place updates.
Never upload either to GitHub or public download storage. Increment `versionCode`
and `versionName` in `app/build.gradle` and the script's output filename for updates.

The public download is `public/downloads/J777-v1.0.3.apk`. Copy the verified build
there when updating the app, then update the link in `src/App.tsx` and the download
header path in `vercel.json`. Publish only the APK; keep signing files private.

## Install / phone checks

Transfer the APK to Android, open it and allow installation from that file source if
Android asks. Keep Android System WebView/Chrome up to date. No additional runtime
permissions are requested.

Before public distribution, check on a real Android phone: signup/signin, keyboard
and six-digit deposit layout, copy receiver number, game launch/audio/fullscreen,
game exit/back to lobby, session persistence, airplane-mode retry and a controlled
payment flow. Build/lint/unit checks do not prove live provider/payment compatibility.
Game pages require working HTTPS and may need provider-side WebView compatibility.

References: [Android WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview),
[URI validation](https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading),
[Android build tool compatibility](https://developer.android.com/build/releases/about-agp).
