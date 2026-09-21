// @vitest-environment node

import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import {
  createCertificateStore,
  FIREBASE_CERTIFICATE_URL,
  KeysUnavailableError,
} from "./firebaseCertificates";
import { googleCertificateFixture } from "../testing/googleCertificateFixture";

const GOOGLE_CACHE_CONTROL = "public, max-age=24246, must-revalidate, no-transform";

let keysByMaterial!: Record<string, CryptoKey>;
const importKey = (material: string) => Promise.resolve(keysByMaterial[material]);

beforeAll(async () => {
  const first = await generateKeyPair("RS256");
  const second = await generateKeyPair("RS256");
  keysByMaterial = { "pem-1": first.publicKey, "pem-2": second.publicKey };
});

const certificates = (
  body: unknown,
  cacheControl: string | null = "public, max-age=300",
  status = 200,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: cacheControl === null ? {} : { "Cache-Control": cacheControl },
  });

describe("Firebase certificate store", () => {
  it("caches a successful fetch for the whole parsed max-age", async () => {
    let clock = 1_000;
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(certificates({ "kid-1": "pem-1" }, GOOGLE_CACHE_CONTROL)),
    );
    const store = createCertificateStore({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      importKey,
      now: () => clock,
    });

    await store.getKey("kid-1");
    await store.getKey("kid-1");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledWith(
      FIREBASE_CERTIFICATE_URL,
      expect.anything(),
    );

    clock = 1_000 + 24_245;
    await store.getKey("kid-1");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    clock = 1_000 + 24_246;
    await store.getKey("kid-1");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it.each([[null], ["no-store"], ["max-age=abc"]])(
    "falls back to the default max-age when Cache-Control is %s",
    async (cacheControl) => {
      let clock = 0;
      const fetchImplementation = vi.fn(() =>
        Promise.resolve(certificates({ "kid-1": "pem-1" }, cacheControl)),
      );
      const store = createCertificateStore({
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
        importKey,
        now: () => clock,
      });

      await store.getKey("kid-1");
      clock = 299;
      await store.getKey("kid-1");
      expect(fetchImplementation).toHaveBeenCalledTimes(1);

      clock = 300;
      await store.getKey("kid-1");
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    },
  );

  it("replaces the key map on rotation so a retired kid stops resolving", async () => {
    let clock = 0;
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(certificates({ "kid-1": "pem-1" }))
      .mockResolvedValueOnce(certificates({ "kid-2": "pem-2" }));
    const store = createCertificateStore({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      importKey,
      now: () => clock,
    });

    await expect(store.getKey("kid-1")).resolves.toBe(keysByMaterial["pem-1"]);

    clock = 400;
    await expect(store.getKey("kid-2")).resolves.toBe(keysByMaterial["pem-2"]);
    await expect(store.getKey("kid-1")).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    let release!: (response: Response) => void;
    const fetchImplementation = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const store = createCertificateStore({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      importKey,
      now: () => 0,
    });

    const both = Promise.all([store.getKey("kid-1"), store.getKey("kid-1")]);
    release(certificates({ "kid-1": "pem-1" }));

    await expect(both).resolves.toEqual([
      keysByMaterial["pem-1"],
      keysByMaterial["pem-1"],
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("refreshes once per cooldown for an unknown kid against a fresh cache", async () => {
    let clock = 0;
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(certificates({ "kid-1": "pem-1" })),
    );
    const store = createCertificateStore({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      importKey,
      now: () => clock,
    });

    await store.getKey("kid-1");
    clock = 60;

    await expect(store.getKey("unknown")).resolves.toBeNull();
    await expect(store.getKey("unknown")).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("returns null rather than throwing when an optional refresh fails", async () => {
    let clock = 0;
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(certificates({ "kid-1": "pem-1" }))
      .mockRejectedValueOnce(new Error("network down"));
    const store = createCertificateStore({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      importKey,
      now: () => clock,
    });

    await store.getKey("kid-1");
    clock = 60;

    await expect(store.getKey("unknown")).resolves.toBeNull();
    // A failed refresh must not clear the cache.
    await expect(store.getKey("kid-1")).resolves.toBe(keysByMaterial["pem-1"]);
  });

  it("throws KeysUnavailableError when a required fetch rejects", async () => {
    const store = createCertificateStore({
      fetchImplementation: (() =>
        Promise.reject(new Error("network down"))) as unknown as typeof fetch,
      importKey,
      now: () => 0,
    });

    await expect(store.getKey("kid-1")).rejects.toBeInstanceOf(KeysUnavailableError);
  });

  it.each([
    ["a 500 response", () => certificates({ "kid-1": "pem-1" }, null, 500)],
    ["a 404 response", () => certificates({ "kid-1": "pem-1" }, null, 404)],
    ["an array body", () => certificates([])],
    ["an empty object body", () => certificates({})],
    ["a non-string entry", () => certificates({ "kid-1": 7 })],
  ])("throws KeysUnavailableError for %s", async (_label, build) => {
    const store = createCertificateStore({
      fetchImplementation: (() => Promise.resolve(build())) as unknown as typeof fetch,
      importKey,
      now: () => 0,
    });

    await expect(store.getKey("kid-1")).rejects.toBeInstanceOf(KeysUnavailableError);
  });

  it("passes an AbortSignal and maps an aborted fetch to KeysUnavailableError", async () => {
    const fetchImplementation = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      () => Promise.reject(new DOMException("aborted", "AbortError")),
    );
    const store = createCertificateStore({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      importKey,
      now: () => 0,
    });

    await expect(store.getKey("kid-1")).rejects.toBeInstanceOf(KeysUnavailableError);
    expect(fetchImplementation.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("imports a real Google X.509 certificate with the default importer", async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        certificates({ [googleCertificateFixture.kid]: googleCertificateFixture.pem }),
      ),
    );
    const store = createCertificateStore({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      now: () => 0,
    });

    const key = await store.getKey(googleCertificateFixture.kid);
    expect(key).not.toBeNull();
    expect(key?.algorithm).toMatchObject({ name: "RSASSA-PKCS1-v1_5" });
  });

  it("returns a default-imported key that jose accepts as a verification key", async () => {
    const store = createCertificateStore({
      fetchImplementation: (() =>
        Promise.resolve(
          certificates({ [googleCertificateFixture.kid]: googleCertificateFixture.pem }),
        )) as unknown as typeof fetch,
      now: () => 0,
    });

    const key = await store.getKey(googleCertificateFixture.kid);
    const { privateKey } = await generateKeyPair("RS256");
    const foreignToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    // The key is usable: jose gets as far as checking the signature and fails
    // there, rather than rejecting the key itself.
    await expect(jwtVerify(foreignToken, key!)).rejects.toMatchObject({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
  });
});
