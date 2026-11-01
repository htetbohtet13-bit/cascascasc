package com.j777ml.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Network pages have no native bridge or local file access. Foreign pages show their host. */
final class NavigationPolicy {
    static final String HOME = "https://www.j777ml.com/";

    private static URI parse(String value) {
        if (value == null || value.length() > 16384) return null;
        try { return new URI(value); } catch (URISyntaxException e) { return null; }
    }

    static boolean isHttps(String value) {
        URI uri = parse(value);
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && uri.getHost() != null && uri.getRawUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    static boolean isWebsite(String value) {
        if (!isHttps(value)) return false;
        String host = host(value);
        return "www.j777ml.com".equals(host) || "j777ml.com".equals(host);
    }

    static String host(String value) {
        URI uri = parse(value);
        return uri == null || uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
    }

    static boolean isExternalAppLink(String value) {
        URI uri = parse(value);
        if (uri == null || uri.getScheme() == null) return false;
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        return scheme.equals("tel") || scheme.equals("mailto") || scheme.equals("viber") || scheme.equals("tg");
    }
}
