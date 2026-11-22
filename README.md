# PDKS – Personel Devam Kontrol Sistemi

NFC personel kartı ile giriş/çıkış kaydı tutan uygulama.

- **Web:** https://deenizacar.github.io/PDKS/ (Android'de Chrome ile Web NFC)
- **Android APK:** https://deenizacar.github.io/PDKS/apk/

## Yapı
- `docs/` – web uygulaması (GitHub Pages buradan yayınlanır). APK da aynı dosyaları kullanır.
- `android/` – WebView tabanlı Android uygulaması (yerel NFC okuma + Türkçe sesli okuma).

## APK derleme
```
cd android
./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk ../docs/apk/PDKS.apk
```
İmzalama anahtarı (`android/pdks-release.jks`, `android/keystore.properties`) depoya eklenmez; güncellemelerin eski sürümün üzerine kurulabilmesi için yedekleyin.
