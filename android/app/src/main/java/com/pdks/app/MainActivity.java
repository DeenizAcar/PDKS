package com.pdks.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Locale;

public class MainActivity extends Activity implements NfcAdapter.ReaderCallback {

    private WebView web;
    private NfcAdapter nfc;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private boolean pageReady = false;

    private final BroadcastReceiver nfcStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            int s = i.getIntExtra(NfcAdapter.EXTRA_ADAPTER_STATE, NfcAdapter.STATE_OFF);
            if (s == NfcAdapter.STATE_ON) enableReader();
            if (s == NfcAdapter.STATE_ON || s == NfcAdapter.STATE_OFF) pushNfcState();
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#0F172A"));

        nfc = NfcAdapter.getDefaultAdapter(this);

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(new Locale("tr", "TR"));
                ttsReady = true;
            }
        });

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0F172A"));
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                pageReady = true;
                pushNfcState();
            }
        });
        setContentView(web);
        hideSystemBars();
        web.loadUrl("file:///android_asset/www/index.html");

        IntentFilter f = new IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(nfcStateReceiver, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(nfcStateReceiver, f);
    }

    private void hideSystemBars() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private boolean nfcEnabled() {
        return nfc != null && nfc.isEnabled();
    }

    private void enableReader() {
        if (nfc == null || !nfc.isEnabled()) return;
        int flags = NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
                | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V
                | NfcAdapter.FLAG_READER_NFC_BARCODE | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;
        Bundle opts = new Bundle();
        opts.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        try {
            nfc.enableReaderMode(this, this, flags, opts);
        } catch (Exception ignored) { }
    }

    private void pushNfcState() {
        if (!pageReady) return;
        final boolean on = nfcEnabled();
        runOnUiThread(() -> web.evaluateJavascript("window.onNativeNfcState&&window.onNativeNfcState(" + on + ")", null));
    }

    @Override
    public void onTagDiscovered(Tag tag) {
        byte[] id = tag.getId();
        if (id == null) return;
        StringBuilder sb = new StringBuilder();
        for (byte x : id) sb.append(String.format("%02X", x));
        final String uid = sb.toString();
        runOnUiThread(() -> web.evaluateJavascript("window.onNativeCard&&window.onNativeCard('" + uid + "')", null));
    }

    @Override
    protected void onResume() {
        super.onResume();
        enableReader();
        pushNfcState();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (nfc != null) {
            try { nfc.disableReaderMode(this); } catch (Exception ignored) { }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
        if (tag != null) onTagDiscovered(tag);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.handleBack?window.handleBack():false", r -> {
            if (!"true".equals(r)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(nfcStateReceiver); } catch (Exception ignored) { }
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    private class Bridge {
        @JavascriptInterface
        public boolean isNfcEnabled() { return nfcEnabled(); }

        @JavascriptInterface
        public boolean hasNfc() { return nfc != null; }

        @JavascriptInterface
        public void speak(String text) {
            if (!ttsReady || text == null) return;
            if (Build.VERSION.SDK_INT >= 21) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "pdks");
        }
    }
}
