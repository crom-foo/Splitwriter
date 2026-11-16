# Pack-Portable.ps1 — Splitwriter portable packer
param(
  [string]$Version = "1.2.0"
)

$Root = (Get-Location).Path
$PackageVersion = if ($Version.EndsWith("-portable", [StringComparison]::OrdinalIgnoreCase)) {
  $Version
} else {
  "{0}-portable" -f $Version
}
$OutDir = Join-Path $Root ("release\splitwriter_v{0}" -f $PackageVersion)
$Zip    = Join-Path $Root ("release\splitwriter_v{0}_win64.zip" -f $PackageVersion)

# 1) 산출물 확인
$ExePath = Join-Path $Root "src-tauri\target\release\Splitwriter.exe"
if (!(Test-Path $ExePath)) {
  Write-Host "❌ 빌드 산출물이 없습니다. 먼저 'npx tauri build'를 실행하세요." -ForegroundColor Red
  exit 1
}

# 2) 배포 폴더 준비
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 3) 파일 복사 (exe + 필요한 dll)
Copy-Item $ExePath $OutDir -Force
Get-ChildItem (Join-Path $Root "src-tauri\target\release") -Filter *.dll -ErrorAction SilentlyContinue | `
  Copy-Item -Destination $OutDir -Force

# 4) 배포용 안내, 변경 기록, 라이선스를 포함
Copy-Item (Join-Path $Root "README_Portable.txt") (Join-Path $OutDir "README.txt") -Force
Copy-Item (Join-Path $Root "CHANGELOG.txt") (Join-Path $OutDir "CHANGELOG.txt") -Force
Copy-Item (Join-Path $Root "LICENSE") (Join-Path $OutDir "LICENSE.txt") -Force

# 6) ZIP으로 묶기(기존 파일 있으면 교체)
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath $Zip -Force

# 7) SHA256 출력
$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash
Write-Host "✅ Pack OK:" $Zip
Write-Host "SHA256:" $hash
