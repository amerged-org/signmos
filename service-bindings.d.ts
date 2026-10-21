// Project-specific extension of the wrangler-generated `BaseEnv`.
// `BaseEnv` (from worker-configuration.d.ts) holds the bindings declared in
// wrangler.jsonc. Add anything else the runtime expects (service bindings,
// queue messages, workflow params, etc.) by extending it here.
interface Env extends BaseEnv {
	OHMYHOST_DATABASE: import("@ohmyhost/customer-runtime/database").CustomerDatabaseBinding;
	OHMYHOST_STORAGE_GATEWAY: Fetcher;
	OHMYHOST_STORAGE_GATEWAY_URL: string;
	OHMYHOST_STORAGE_KEY: string;
	OHMYHOST_PROJECT_ID: string;
	OHMYHOST_ENVIRONMENT_ID: string;
	OHMYHOST_MAIL_GATEWAY?: Fetcher;
	OHMYHOST_MAIL_GATEWAY_URL?: string;
	OHMYHOST_MAIL_KEY?: string;
	SIGN_ADMIN_EMAILS?: string;
	SIGN_FROM_EMAIL?: string;
	SIGN_REPLY_TO_EMAIL?: string;
}
