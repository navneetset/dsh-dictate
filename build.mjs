import { build } from "esbuild";

// Host half: ESM for Node, schemastery + dsh packages stay external.
await build({
	entryPoints: ["src/host/index.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	outfile: "lib/index.js",
	external: ["@deepseek-ai/*"],
});

// Client half: CJS body inside the dsh module-loader envelope. `require`
// resolves react and injected client packages through the loader's shared
// table, so they stay external.
await build({
	entryPoints: ["src/client/entry.tsx"],
	bundle: true,
	platform: "browser",
	format: "cjs",
	target: "es2022",
	outfile: "dist/client.js",
	external: ["react", "react-dom", "react/jsx-runtime", "@deepseek-ai/*"],
	banner: {
		js: [
			'window.__ModuleLoader__.load({',
			'	id: "dsh-plugin-dictate",',
			'	factory: (require) => {',
			'		var module = { exports: {} };',
			'		var exports = module.exports;',
		].join("\n"),
	},
	footer: {
		js: "\n\t\treturn module.exports;\n\t}\n});",
	},
});

console.log("dsh-plugin-dictate: built lib/index.js and dist/client.js");
