package com.j777ml.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int CREAM = 0xfffff8e9;
    private static final int INK = 0xff342719;
    private WebView webView;
    private FrameLayout page;
    private LinearLayout loading;
    private LinearLayout error;
    private LinearLayout externalBar;
    private TextView externalHost;
    private View fullScreenView;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private String retryUrl = NavigationPolicy.HOME;
    private boolean pageFailed;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        buildLayout();
        configureWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::handleBack);
        }
        // Never accept a URL or JavaScript from an incoming intent.
        webView.loadUrl(NavigationPolicy.HOME);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(INK);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private Button button(int label, View.OnClickListener click) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(INK);
        button.setAllCaps(false);
        button.setOnClickListener(click);
        return button;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " J777App/" + BuildConfig.VERSION_NAME);
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(false);
        webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        webView.setBackgroundColor(CREAM);
        WebView.setWebContentsDebuggingEnabled(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        // No addJavascriptInterface: website code has no access to native app objects.
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (NavigationPolicy.isHttps(url)) return false;
                if (request.isForMainFrame() && request.hasGesture() && NavigationPolicy.isExternalAppLink(url)) {
                    openExternal(url);
                }
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageFailed = false;
                if (NavigationPolicy.isHttps(url)) retryUrl = url;
                error.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                loading.setVisibility(View.VISIBLE);
                updateExternalBar(url);
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (!pageFailed) loading.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
                updateExternalBar(url);
            }

            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                updateExternalBar(url);
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError detail) {
                if (request.isForMainFrame()) showError(request.getUrl().toString());
            }

            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) showError(request.getUrl().toString());
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError detail) {
                handler.cancel();
                if (detail.getUrl().equals(view.getUrl())) showError(detail.getUrl());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int progress) {
                if (!pageFailed && progress == 100) loading.setVisibility(View.GONE);
            }

            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }

            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullScreenView != null) { callback.onCustomViewHidden(); return; }
                fullScreenView = view;
                fullScreenCallback = callback;
                page.addView(view, new FrameLayout.LayoutParams(-1, -1));
                if (Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null) {
                    getWindow().getInsetsController().hide(WindowInsets.Type.systemBars());
                }
            }

            @Override public void onHideCustomView() { closeFullScreen(); }
        });
        // Downloads go to the browser; the app requests no storage or install permissions.
        webView.setDownloadListener((url, agent, disposition, mime, length) -> {
            if (NavigationPolicy.isHttps(url)) openExternal(url);
        });
    }

    @SuppressLint("RtlHardcoded")
    private void buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(CREAM);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            if (Build.VERSION.SDK_INT >= 30) return WindowInsets.CONSUMED;
            return insets.consumeSystemWindowInsets();
        });
        setContentView(root);
        root.requestApplyInsets();

        externalBar = new LinearLayout(this);
        externalBar.setGravity(Gravity.CENTER_VERTICAL);
        externalBar.setPadding(dp(6), 0, dp(8), 0);
        Button home = button(R.string.home, v -> webView.loadUrl(NavigationPolicy.HOME));
        home.setTextSize(11);
        externalBar.addView(home, new LinearLayout.LayoutParams(-2, dp(48)));
        externalHost = text("", 11);
        externalHost.setMaxLines(1);
        externalHost.setEllipsize(android.text.TextUtils.TruncateAt.END);
        externalBar.addView(externalHost, new LinearLayout.LayoutParams(0, -2, 1));
        externalBar.setVisibility(View.GONE);
        root.addView(externalBar);

        page = new FrameLayout(this);
        root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
        webView = new WebView(this);
        page.addView(webView, new FrameLayout.LayoutParams(-1, -1));

        loading = new LinearLayout(this);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(dp(10), dp(5), dp(10), dp(5));
        loading.setBackgroundColor(0xf5fff8e9);
        ProgressBar spinner = new ProgressBar(this);
        spinner.setIndeterminateTintList(ColorStateList.valueOf(0xffb87d16));
        loading.addView(spinner, new LinearLayout.LayoutParams(dp(22), dp(22)));
        TextView label = text(getString(R.string.loading), 12);
        label.setPadding(dp(10), 0, 0, 0);
        loading.addView(label);
        FrameLayout.LayoutParams loadingPosition = new FrameLayout.LayoutParams(-1, dp(40), Gravity.TOP);
        page.addView(loading, loadingPosition);

        error = new LinearLayout(this);
        error.setOrientation(LinearLayout.VERTICAL);
        error.setGravity(Gravity.CENTER);
        error.setPadding(dp(28), dp(20), dp(28), dp(20));
        error.setBackgroundColor(CREAM);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.brand_logo);
        logo.setContentDescription(getString(R.string.app_name));
        error.addView(logo, new LinearLayout.LayoutParams(dp(88), dp(88)));
        TextView title = text(getString(R.string.connection_title), 20);
        title.setTypeface(null, Typeface.BOLD);
        title.setPadding(0, dp(20), 0, dp(8));
        error.addView(title);
        TextView description = text(getString(R.string.connection_message), 14);
        description.setPadding(0, 0, 0, dp(16));
        error.addView(description);
        Button retry = button(R.string.retry, v -> webView.loadUrl(retryUrl));
        GradientDrawable gold = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0xffffe29a, 0xffeabb4d});
        gold.setCornerRadius(dp(12));
        retry.setBackground(gold);
        error.addView(retry, new LinearLayout.LayoutParams(-1, dp(52)));
        error.addView(button(R.string.home, v -> webView.loadUrl(NavigationPolicy.HOME)));
        error.setVisibility(View.GONE);
        page.addView(error, new FrameLayout.LayoutParams(-1, -1));
    }

    private void updateExternalBar(String url) {
        boolean foreign = NavigationPolicy.isHttps(url) && !NavigationPolicy.isWebsite(url);
        externalHost.setText(NavigationPolicy.host(url));
        externalBar.setVisibility(foreign ? View.VISIBLE : View.GONE);
    }

    private void showError(String url) {
        pageFailed = true;
        if (NavigationPolicy.isHttps(url)) retryUrl = url;
        loading.setVisibility(View.GONE);
        webView.setVisibility(View.INVISIBLE);
        error.setVisibility(View.VISIBLE);
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.cannot_open, Toast.LENGTH_SHORT).show();
        }
    }

    private void closeFullScreen() {
        if (fullScreenView == null) return;
        page.removeView(fullScreenView);
        fullScreenView = null;
        WebChromeClient.CustomViewCallback callback = fullScreenCallback;
        fullScreenCallback = null;
        if (Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null) {
            getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
        }
        if (callback != null) callback.onCustomViewHidden();
    }

    private void handleBack() {
        if (fullScreenView != null) closeFullScreen();
        else if (webView.canGoBack()) webView.goBack();
        else new AlertDialog.Builder(this).setTitle(R.string.exit_title)
                .setPositiveButton(R.string.exit, (dialog, which) -> finish())
                .setNegativeButton(R.string.cancel, null).show();
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { handleBack(); }

    @Override protected void onPause() {
        CookieManager.getInstance().flush();
        webView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override protected void onDestroy() {
        closeFullScreen();
        if (webView != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
        }
        super.onDestroy();
    }
}
