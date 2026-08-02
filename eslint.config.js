import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  eslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      globals: {
        window: "readonly",
        document: "readonly",
        HTMLElement: "readonly",
        customElements: "readonly",
        console: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        fetch: "readonly",
        Image: "readonly",
        requestIdleCallback: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        WebGL2RenderingContext: "readonly",
        WebGLTexture: "readonly",
        WebGLProgram: "readonly",
        WebGLShader: "readonly",
        WebGLVertexArrayObject: "readonly",
        DOMParser: "readonly",
        Event: "readonly",
        MouseEvent: "readonly",
        HTMLCanvasElement: "readonly",
        HTMLImageElement: "readonly",
        ImageBitmap: "readonly",
        TexImageSource: "readonly",
        process: "readonly",
        Float64Array: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  prettier,
  { ignores: ["dist/**", "dist-types/**", "node_modules/**"] },
];
