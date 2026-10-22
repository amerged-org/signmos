import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const config = defineConfig({
	plugins: [
		// this is the plugin that enables path aliases
		viteTsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
		tailwindcss(),
		cloudflare({
			viteEnvironment: {
				name: "ssr",
			},
			// The ohmyho.st build checks the generated Worker config key by key. Wrangler 4.151 adds
			// an empty `k2` list that its allow-list does not know yet.
			config: (workerConfig) => {
				delete (workerConfig as { k2?: unknown }).k2;
			},
		}),
		tanstackStart({
			srcDirectory: "src",
			start: { entry: "./start.tsx" },
		}),
		viteReact(),
	],
	environments: {
		// Source maps of the Worker bundle are not part of the deployable output (the ohmyho.st
		// packaging refuses *.map files under dist/server); the plugin otherwise emits them.
		ssr: {
			build: {
				sourcemap: false,
				// The packaging also scans the Worker text for "<prefix>/assets/" references. pdf-lib's
				// JSDoc examples (https://pdf-lib.js.org/assets/...) match; they are not code.
				rolldownOptions: { output: { comments: { jsdoc: false } } },
			},
		},
	},
});

export default config;
