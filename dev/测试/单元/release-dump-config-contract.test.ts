import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const releaseCheckPath = resolve(process.cwd(), "scripts", "release-check.mjs");
const releaseCheckSource = readFileSync(releaseCheckPath, "utf8");
const sourceFile = ts.createSourceFile(
  releaseCheckPath,
  releaseCheckSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

let patternNode: ts.VariableDeclaration | undefined;
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "persistentBundleRowPattern") {
    patternNode = node;
  }
  ts.forEachChild(node, visit);
};
visit(sourceFile);

describe("release dump-config persistent bundle row contract", () => {
  it("reads the current gate regex instead of copying its rule", () => {
    expect(patternNode?.initializer).toBeDefined();
    const initializer = patternNode!.initializer!;
    const initializerSource = releaseCheckSource.slice(
      initializer.getStart(sourceFile),
      initializer.end,
    );
    const persistentBundleRowPattern = new Function(
      `return (${initializerSource});`,
    )() as RegExp;

    expect(persistentBundleRowPattern).toBeInstanceOf(RegExp);
    expect(persistentBundleRowPattern.test(
      "      - name: dsh-plugin-bash-wsl/persistent\n",
    )).toBe(true);

    const acceptedRows = [
      "name: dsh-plugin-bash-wsl/persistent\n",
      "  - name: 'dsh-plugin-bash-wsl/persistent'\r\n",
      "nested:\r\n  plugins:\r\n    - name: \"dsh-plugin-bash-wsl/persistent\"\r\n",
    ];
    for (const dump of acceptedRows) {
      expect(persistentBundleRowPattern.test(dump)).toBe(true);
    }

    const rejectedRows = [
      ["missing row", "name: dsh-plugin-bash-wsl\n"],
      ["wrong prefix", "name: xdsh-plugin-bash-wsl/persistent\n"],
      ["wrong suffix", "name: dsh-plugin-bash-wsl/persistent-extra\n"],
      ["unbalanced single quote", "name: 'dsh-plugin-bash-wsl/persistent\n"],
      ["unbalanced double quote", "name: \"dsh-plugin-bash-wsl/persistent\n"],
      ["commented row", "# name: dsh-plugin-bash-wsl/persistent\n"],
      ["inline comment", "name: dsh-plugin-bash-wsl/persistent # comment\n"],
      ["wrong name", "name: dsh-plugin-bash-wsl/persist\n"],
      ["cross-field text", "bundle: name: dsh-plugin-bash-wsl/persistent\n"],
      ["empty dump", ""],
    ] as const;
    for (const [label, dump] of rejectedRows) {
      expect(persistentBundleRowPattern.test(dump), label).toBe(false);
    }
  });
});
