package com.j777ml.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class NavigationPolicyTest {
    @Test public void websiteRequiresExactHttpsHost() {
        assertTrue(NavigationPolicy.isWebsite(NavigationPolicy.HOME));
        assertTrue(NavigationPolicy.isWebsite("https://j777ml.com:443/?x=1"));
        assertTrue(NavigationPolicy.isWebsite("HTTPS://WWW.J777ML.COM/"));
        for (String value : new String[]{"http://www.j777ml.com/", "https://www.j777ml.com.attacker.com/",
                "https://www.j777ml.com@attacker.com/", "https://attacker.com/?www.j777ml.com",
                "https://evil@www.j777ml.com/", "https://www.j777ml.com:3001/", "https://www.j777ml.com./"}) {
            assertFalse(value, NavigationPolicy.isWebsite(value));
        }
    }

    @Test public void providerHttpsPagesAreSeparateFromWebsite() {
        String url = "https://games.example.com/play?token=temporary";
        assertTrue(NavigationPolicy.isHttps(url));
        assertFalse(NavigationPolicy.isWebsite(url));
        assertEquals("games.example.com", NavigationPolicy.host(url));
    }

    @Test public void refusesLocalFilesScriptsAndMalformedUrls() {
        for (String value : new String[]{null, "", "file:///data/data/private", "content://private",
                "javascript:alert(1)", "intent://example", "data:text/html,test", "http://example.com/",
                "https:///example.com", "https://user:password@example.com/", "https://example.com:22/",
                "https://example.com/\n", "https://exa mple.com/", "https://www.j777ml.com\\@evil.com/"}) {
            assertFalse(value, NavigationPolicy.isHttps(value));
        }
    }

    @Test public void externalLinksHaveOnlyExplicitSchemes() {
        assertTrue(NavigationPolicy.isExternalAppLink("tel:09123456789"));
        assertTrue(NavigationPolicy.isExternalAppLink("mailto:help@example.com"));
        assertTrue(NavigationPolicy.isExternalAppLink("tg://resolve?domain=test"));
        assertFalse(NavigationPolicy.isExternalAppLink("intent://example"));
        assertFalse(NavigationPolicy.isExternalAppLink("file:///etc/passwd"));
    }
}
