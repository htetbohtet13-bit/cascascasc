param([switch]$InitializeSigning)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot

# Reuse an installed JDK / SDK; Android Studio's paths also work via environment variables.
$jdkPath = $env:JAVA_HOME
if (-not $jdkPath -or -not (Test-Path (Join-Path $jdkPath 'bin\java.exe'))) {
    $jdkPath = Get-ChildItem "$env:USERPROFILE\.bubblewrap\jdk" -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $jdkPath) { throw 'Install JDK 17 and set JAVA_HOME to its directory.' }
$env:JAVA_HOME = $jdkPath
$sdkPath = $env:ANDROID_HOME
if (-not $sdkPath) { $sdkPath = $env:ANDROID_SDK_ROOT }
if (-not $sdkPath -and (Test-Path "$env:LOCALAPPDATA\Android\Sdk")) { $sdkPath = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not $sdkPath -and (Test-Path "$env:USERPROFILE\.bubblewrap\android_sdk")) { $sdkPath = "$env:USERPROFILE\.bubblewrap\android_sdk" }
if (-not $sdkPath) { throw 'Install Android SDK platform 36 and build-tools 35.0.0; set ANDROID_HOME.' }
$env:ANDROID_HOME = $sdkPath
$sdkProperty = 'sdk.dir=' + ($sdkPath -replace '\\', '/')
[IO.File]::WriteAllText((Join-Path $projectRoot 'local.properties'), $sdkProperty + "`n")

$signingDirectory = Join-Path $projectRoot '.signing'
$signingProperties = Join-Path $projectRoot 'keystore.properties'
$keystorePath = Join-Path $signingDirectory 'j777-release.jks'
if ($InitializeSigning) {
    if ((Test-Path $keystorePath) -or (Test-Path $signingProperties)) {
        throw 'Signing files already exist. Rebuild without -InitializeSigning; never replace the original key.'
    }
    New-Item -ItemType Directory -Path $signingDirectory -Force | Out-Null
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $password = [Convert]::ToBase64String($bytes)
    $env:J777_BUILD_KEY_PASSWORD = $password
    try {
        & (Join-Path $jdkPath 'bin\keytool.exe') -genkeypair -keystore $keystorePath -storetype JKS `
            -alias j777 -keyalg RSA -keysize 3072 -validity 10000 `
            -dname 'CN=J777, O=J777' -storepass:env J777_BUILD_KEY_PASSWORD `
            -keypass:env J777_BUILD_KEY_PASSWORD -noprompt
        if ($LASTEXITCODE -ne 0) { throw 'Could not generate the signing key.' }
        $values = "storeFile=.signing/j777-release.jks`nstorePassword=$password`nkeyAlias=j777`nkeyPassword=$password`n"
        [IO.File]::WriteAllText($signingProperties, $values)
    } finally {
        Remove-Item Env:\J777_BUILD_KEY_PASSWORD -ErrorAction SilentlyContinue
        $password = $null
    }
}
if (-not (Test-Path $signingProperties) -or -not (Test-Path $keystorePath)) {
    throw 'Release signing is missing. Run with -InitializeSigning once on the first build.'
}

Push-Location $projectRoot
try {
    & '.\gradlew.bat' --no-daemon --console=plain testReleaseUnitTest lintRelease assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android build or checks failed.' }
    $artifactDirectory = Join-Path (Split-Path $projectRoot -Parent) 'artifacts'
    New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
    $apkPath = Join-Path $artifactDirectory 'J777-v1.0.1.apk'
    Copy-Item -LiteralPath '.\app\build\outputs\apk\release\app-release.apk' -Destination $apkPath -Force
    & (Join-Path $sdkPath 'build-tools\35.0.0\apksigner.bat') verify --verbose $apkPath
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $apkHash = Get-FileHash -LiteralPath $apkPath -Algorithm SHA256
    $hashLine = $apkHash.Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($apkPath)
    [IO.File]::WriteAllText($apkPath + '.sha256', $hashLine + "`n")
    $apkHash
    Write-Output "APK ready: $apkPath"
} finally { Pop-Location }
