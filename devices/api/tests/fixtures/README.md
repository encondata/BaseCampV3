# Test fixtures

## `hello-a.apk` and `hello-a2.apk`

Two tiny signed APKs for `tests/test_apk.py`. Both are package
`com.example.hello`, label "Hello Fixture", minSdk 26, with a 48x48 PNG
launcher icon and no code.

| File | versionCode | versionName | Signed with |
| --- | --- | --- | --- |
| `hello-a.apk` | 1 | 1.0 | key A (`CN=Fixture Key A`) |
| `hello-a2.apk` | 2 | 1.1 | key B (`CN=Fixture Key B`) |

Signer certificate SHA-256 (as `apksigner verify --print-certs` prints it):

- key A: `2eb648de103c7514530f1d0a85f492a5e924ad53e4e94700b0115e19575f1e1f`
- key B: `96c8b9d024605bc3455e7779a9b4efe5c57f69a5b3d528d152b2cb7710ca39a4`

The keystores were throwaway files in a scratch directory and are not kept.
Rebuilding makes new keys: update the digests above and `KEY_A_DIGEST` /
`KEY_B_DIGEST` in `tests/test_apk.py`, which asserts them exactly.

Built on macOS with Android build-tools 36.0.0, platform android-35 and
Android Studio's bundled JBR:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
BT=~/Library/Android/sdk/build-tools/36.0.0
JAR=~/Library/Android/sdk/platforms/android-35/android.jar
mkdir -p build/res/mipmap-mdpi build/res/values && cd build

# 48x48 solid RGBA launcher icon
python3 - <<'EOF'
import struct, zlib
def chunk(t, b): return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
w = h = 48
rows = b''.join(b'\x00' + bytes([30, 120, 200, 255]) * w for _ in range(h))
png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))
open('res/mipmap-mdpi/ic_launcher.png', 'wb').write(png)
EOF

cat > res/values/strings.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Hello Fixture</string>
</resources>
EOF

mk_manifest() { cat > AndroidManifest.xml <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.hello"
    android:versionCode="$1"
    android:versionName="$2">
    <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35" />
    <application android:label="@string/app_name" android:icon="@mipmap/ic_launcher" android:hasCode="false" />
</manifest>
EOF
}

$BT/aapt2 compile --dir res -o res.zip

"$JAVA_HOME/bin/keytool" -genkeypair -keystore key-a.jks -alias a -keyalg RSA -keysize 2048 \
  -validity 10000 -storepass testpass -keypass testpass -dname "CN=Fixture Key A"
"$JAVA_HOME/bin/keytool" -genkeypair -keystore key-b.jks -alias b -keyalg RSA -keysize 2048 \
  -validity 10000 -storepass testpass -keypass testpass -dname "CN=Fixture Key B"

build() {  # versionCode versionName keystore alias output
  mk_manifest "$1" "$2"
  $BT/aapt2 link -o unsigned.apk -I "$JAR" --manifest AndroidManifest.xml res.zip
  rm -f aligned.apk; $BT/zipalign -p 4 unsigned.apk aligned.apk
  $BT/apksigner sign --ks "$3" --ks-key-alias "$4" --ks-pass pass:testpass \
    --key-pass pass:testpass --out "$5" aligned.apk
}
build 1 1.0 key-a.jks a hello-a.apk
build 2 1.1 key-b.jks b hello-a2.apk
```

`apksigner` writes all three signature schemes: the v1 (JAR) files under
`META-INF/` as well as the v2 and v3 blocks. At minSdk 26, `apksigner verify`
reports only v2 and v3 as verified.

## IPA fixtures

There are no IPA files here. `tests/test_ipa.py` builds each IPA in a temp
directory: a zip holding `Payload/Hello.app/Info.plist` (binary plist), a
CgBI icon made by running the decoder in reverse, and an
`embedded.mobileprovision` CMS-signed with a self-made certificate through
`cryptography`'s `PKCS7SignatureBuilder`.
