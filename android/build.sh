#!/usr/bin/env bash
# Fabrique android/build/kilosaurus-temps.apk sans Gradle ni Android Studio, avec le kit Android
# fourni par Unity (ou ANDROID_SDK / JAVA_HOME s'ils sont définis). Aucun accès réseau.
#
#   bash android/build.sh
#
# La clé de signature (android/release.keystore + android/keystore.properties) est créée au
# premier lancement. Gardez-la : une mise à jour de l'app doit être signée avec la même clé,
# sinon il faut désinstaller l'ancienne version (et perdre ses réglages).
set -euo pipefail

# Chemins au format C:/… : compris à la fois par bash et par les outils Windows (javac, aapt2…).
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
HERE="$(winpath "$(cd "$(dirname "$0")" && pwd)")"
ROOT="$(dirname "$HERE")"
UNITY_ANDROID="$(ls -d "/c/Program Files/Unity/Hub/Editor/"*/Editor/Data/PlaybackEngines/AndroidPlayer 2>/dev/null | sort | tail -1 || true)"
SDK="$(winpath "${ANDROID_SDK:-$UNITY_ANDROID/SDK}")"
JDK="$(winpath "${JAVA_HOME:-$UNITY_ANDROID/OpenJDK}")"
PLATFORM="$(ls -d "$SDK/platforms/android-"* | sort -V | grep -E 'android-[0-9]+$' | tail -1)"
TOOLS="$(ls -d "$SDK/build-tools/"* | sort -V | tail -1)"
API_LEVEL="${PLATFORM##*android-}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
EXE=""; [ -f "$TOOLS/aapt2.exe" ] && EXE=".exe"

echo "SDK : $PLATFORM ($TOOLS)"
OUT="$HERE/build"
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/extra/assets/web"

# L'interface web, servie depuis les assets de l'APK (le service worker ne sert qu'au web).
cp -r "$ROOT/web/." "$OUT/extra/assets/web/"
rm -f "$OUT/extra/assets/web/sw.js"

"$TOOLS/aapt2$EXE" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$TOOLS/aapt2$EXE" link -o "$OUT/base.apk" -I "$PLATFORM/android.jar" \
  --manifest "$HERE/AndroidManifest.xml" --java "$OUT/gen" \
  --min-sdk-version 26 --target-sdk-version "$API_LEVEL" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" "$OUT/res.zip"

# Classes Java standard depuis le JDK, classes Android depuis android.jar ; d8 adapte le tout.
find "$HERE/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
"$JDK/bin/javac" -nowarn --release 11 -encoding UTF-8 -classpath "$PLATFORM/android.jar" \
  -d "$OUT/classes" @"$OUT/sources.txt"

# Les .bat du SDK cassent sur les chemins avec espaces : on appelle leurs .jar directement.
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$JDK/bin/java" -cp "$TOOLS/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 26 \
  --lib "$PLATFORM/android.jar" --output "$OUT/dex" $(cat "$OUT/classes.txt")

# Ajout du code compilé et de l'interface web dans l'APK produit par aapt2. On passe par jar plutôt
# que par l'option -A d'aapt2 : sous Windows, aapt2 range les assets sous des chemins en « \ »,
# qu'Android ne retrouve pas.
cp "$OUT/dex/classes.dex" "$OUT/extra/"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/extra" && "$JDK/bin/jar" --update --no-manifest --file "$OUT/unsigned.apk" classes.dex assets)

"$TOOLS/zipalign$EXE" -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KS="$HERE/release.keystore"
PROPS="$HERE/keystore.properties"
if [ ! -f "$KS" ]; then
  PASS="$(head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24)"
  "$JDK/bin/keytool" -genkeypair -keystore "$KS" -alias kt -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" -dname "CN=Kilosaurus Temps, O=Kilosaurus" >/dev/null 2>&1
  echo "password=$PASS" > "$PROPS"
  echo "Clé de signature créée : $KS (à sauvegarder)."
fi
PASS="$(sed -n 's/^password=//p' "$PROPS")"
"$JDK/bin/java" -jar "$TOOLS/lib/apksigner.jar" sign --ks "$KS" --ks-key-alias kt \
  --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --out "$OUT/kilosaurus-temps.apk" "$OUT/aligned.apk"
"$JDK/bin/java" -jar "$TOOLS/lib/apksigner.jar" verify "$OUT/kilosaurus-temps.apk"
echo "APK : $OUT/kilosaurus-temps.apk"

# Dépôt automatique, facultatif : si android/local.properties (jamais commité) contient
# apk_drop=<dossier>, l'APK y est copié à chaque build, en remplaçant le précédent. Un dossier
# Google Drive synchronisé permet ainsi d'installer la dernière version depuis le téléphone.
LOCAL="$HERE/local.properties"
DROP=""
[ -f "$LOCAL" ] && DROP="$(sed -n 's/^apk_drop=//p' "$LOCAL" | tr -d '\r')"
if [ -n "$DROP" ]; then
  mkdir -p "$DROP"
  cp "$OUT/kilosaurus-temps.apk" "$DROP/kilosaurus-temps.apk"
  echo "Copié dans : $DROP"
fi
