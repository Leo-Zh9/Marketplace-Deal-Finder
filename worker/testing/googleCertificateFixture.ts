// A real public X.509 certificate from Google's securetoken endpoint, committed as a TEST
// FIXTURE ONLY.
//
// 1. An X.509 certificate is public material. It contains a public key and no private key.
//    Committing it leaks nothing.
// 2. It is NEVER a trust anchor. Nothing in worker/auth/ imports this file. The production
//    path always fetches FIREBASE_CERTIFICATE_URL at runtime. This fixture exists solely so
//    the default importX509 wiring can be proven offline.
// 3. It does not expire for test purposes: jose's fromX509
//    (node_modules/jose/dist/webapi/lib/asn1.js) extracts the SPKI via spkiFromX509 and calls
//    genericImport("spki", ...). There is no notBefore/notAfter handling anywhere in that
//    file, so this fixture keeps importing after the certificate's own validity period ends
//    and never needs refreshing.
export const googleCertificateFixture = {
  kid: "6f7de798eee8a24ebade6f228411220c8669010d",
  pem: "-----BEGIN CERTIFICATE-----\nMIIDHDCCAgSgAwIBAgIIFFdImQ/V0kUwDQYJKoZIhvcNAQEFBQAwMTEvMC0GA1UE\nAwwmc2VjdXJldG9rZW4uc3lzdGVtLmdzZXJ2aWNlYWNjb3VudC5jb20wHhcNMjYw\nNTA0MTc0NzI3WhcNMjcwNTA0MTc0NzI3WjAxMS8wLQYDVQQDDCZzZWN1cmV0b2tl\nbi5zeXN0ZW0uZ3NlcnZpY2VhY2NvdW50LmNvbTCCASIwDQYJKoZIhvcNAQEBBQAD\nggEPADCCAQoCggEBAOKOpTkKGfjHH1ny5ZJXKag63eWg9RvVlfY3SgKULip4mwM1\nHuCIY0aYoXEdKdVFgS/+mPOPDfSSjcYbl1/+QTZH0mBiqatIgQGegNf5naIkF9jd\nSxazYShP8cgjOkRckaFdrMvEa/mNOO5wTk6AEMbUR+V1M8auOAiqeAGOvTTgbOJl\nbRB9NufzI8WbysbEPRtgqDYY9WxXcrukkacecYsaLkj0qy14DTZXt08NB+ZlYnHQ\n2+qoEo33lMMm67gpBTPe3mu4L9CrZ9qDxzH7WqMz+7zGeA9FqDwyMu9UONE+Ssbs\nxYN6dtw12vC1S6ueAzdGgWCOTB8njBAvkrYJ0gMCAwEAAaM4MDYwDAYDVR0TAQH/\nBAIwADAOBgNVHQ8BAf8EBAMCB4AwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwIwDQYJ\nKoZIhvcNAQEFBQADggEBALxRVxyzG7sUYwBdUGOQ8wWt7o/1tvgAVKa9VpgzzlHb\nW4irMEOCetKswJFN4KieFqfUcwsKucRiDZRm9iIrPTyI3AhH9Yu7UY7lrqkYZ//b\nv1Q+oj1YqYcwHcyhuykzQIf+eq1reBWhG0GaDfxTdIeQkcYBZ5nVNICBXU2QVJLE\nqjM89ncbpinVTzI7kH1uZvqMDeL7/su6GSvoi4oXokOauGcaogwbbE+HK//QMOMK\nXSu2FfrwU5Vua5Mx37jQTnM5ruVJQvnNYsd9QAMfhd7cUMMYuIAW1sQMSk5/F95Q\nQCCW8kDKq9yAOrfHSS2zw5pqsIc/HC/bD3cW9J0CYK8=\n-----END CERTIFICATE-----\n",
};
