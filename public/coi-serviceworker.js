/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// Injects COOP/COEP response headers via a service worker so the app is
// cross-origin isolated (required by WebContainer) on ANY static host — no
// server config needed. Set `window.coi = { coepCredentialless: () => true }`
// in index.html before this loads.
let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => self.clients.matchAll())
                .then((clients) => clients.forEach((client) => client.navigate(client.url)));
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }
        // Never isolate the /deploy page — it needs popup auth (Puter), which
        // COOP same-origin would break. Let it load with its own (no-COI) headers.
        try {
            const u = new URL(r.url);
            if (u.origin === self.location.origin && (u.pathname === "/deploy" || u.pathname.startsWith("/deploy.html"))) {
                return;
            }
        } catch (e) { /* ignore */ }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, { credentials: "omit" })
            : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });
} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // Customize via a global `coi` variable.
        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => !(window.chrome === undefined && window.netscape === undefined),
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;
        const controlling = n.serviceWorker && n.serviceWorker.controller;

        if (controlling && !window.crossOriginIsolated) {
            window.sessionStorage.setItem("coiCoepHasFailed", "true");
        }
        const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");

        if (controlling) {
            const reloadToDegrade = coi.coepDegrade() && !(coepDegrading || window.crossOriginIsolated);
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (reloadToDegrade || (coepHasFailed && coi.coepDegrade())) ? false : coi.coepCredentialless(),
            });
            if (reloadToDegrade) {
                window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                coi.doReload("coepdegrade");
            }
        } else if (coi.shouldRegister()) {
            n.serviceWorker.register(window.document.currentScript.src).then(
                (registration) => {
                    !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                    registration.addEventListener("updatefound", () => {
                        window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                        coi.doReload();
                    });

                    if (registration.active && !n.serviceWorker.controller) {
                        window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                        coi.doReload();
                    }
                },
                (err) => { !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err); }
            );
        }
    })();
}
