import { buildPartnerVerificationEmail, isResendConfigured } from "./email-delivery";

const configured = {
	RESEND_API_KEY: "re_configured",
	RESEND_FROM_EMAIL: "signing@signmos.test",
	RESEND_REPLY_TO_EMAIL: "reply@signmos.test",
};

describe("development email delivery fixture", () => {
	it("allows an explicit non-production fallback without weakening production delivery", () => {
		expect(
			isResendConfigured({
				...configured,
				CLOUDFLARE_ENV: "development",
				EMAIL_DELIVERY_TEST_BYPASS: "true",
			}),
		).toBe(false);
		expect(
			isResendConfigured({
				...configured,
				CLOUDFLARE_ENV: "production",
				EMAIL_DELIVERY_TEST_BYPASS: "true",
			}),
		).toBe(true);
	});
});

it("keeps the invitation link and timing in both branded HTML and plain text", () => {
	const url = "https://sign.example.test/signing-verifications/test-token";
	const email = buildPartnerVerificationEmail({
		email: "ada@example.test",
		recipientName: "Ada <Test>",
		verificationUrl: url,
	});
	expect(email.text).toContain(url);
	expect(email.html).toContain(`href="${url}"`);
	expect(email.text).toContain("7 Tage");
	expect(email.html).toContain("7 Tage");
	expect(email.html).toContain("Ada &lt;Test&gt;");
	expect(email.html).toContain("amerged-logo-email.png");
});
