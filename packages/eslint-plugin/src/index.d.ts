import type { ESLint, Linter } from 'eslint';

export declare const rules: NonNullable<ESLint.Plugin['rules']>;
export declare const burrowEslintPlugin: ESLint.Plugin;
export declare const recommendedRules: Linter.RulesRecord;
export declare const configs: {
  recommended: Linter.Config[];
};

export default burrowEslintPlugin;
