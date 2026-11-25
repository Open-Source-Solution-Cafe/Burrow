const BLOCKED_MODULES = new Set([
  'child_process',
  'node:child_process',
  'vm',
  'node:vm',
  'inspector',
  'node:inspector',
  'worker_threads',
  'node:worker_threads',
]);

const DB_EXEC_METHODS = new Set(['query', 'first', 'execute', 'all', 'run', 'exec', 'prepare']);

function isSanitizerCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee?.type === 'Identifier') {
    return callee.name === 'sanitizePluginHtml';
  }
  if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
    return callee.property.name === 'sanitizePluginHtml';
  }
  return false;
}

function unwrapTsNode(node) {
  let cur = node;
  while (
    cur &&
    (cur.type === 'TSAsExpression' ||
      cur.type === 'TSTypeAssertion' ||
      cur.type === 'TSNonNullExpression' ||
      cur.type === 'ParenthesizedExpression')
  ) {
    cur = cur.expression;
  }
  return cur;
}

function getStringLiteralValue(node) {
  const cur = unwrapTsNode(node);
  if (!cur) return null;
  if (cur.type === 'Literal' && typeof cur.value === 'string') return cur.value;
  if (cur.type === 'TemplateLiteral' && cur.expressions.length === 0) {
    return cur.quasis.map((q) => q.value.cooked ?? '').join('');
  }
  if (cur.type === 'BinaryExpression' && cur.operator === '+') {
    const left = getStringLiteralValue(cur.left);
    const right = getStringLiteralValue(cur.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

function containsUnsafeSqlExpression(node, unsafeVars) {
  if (!node) return false;
  if (node.type === 'BinaryExpression' && node.operator === '+') return true;
  if (node.type === 'TemplateLiteral' && node.expressions.length > 0) return true;
  if (node.type === 'Identifier' && unsafeVars.has(node.name)) return true;
  return false;
}

const GLOBAL_IDENTIFIERS = new Set(['globalThis', 'global', 'window', 'self']);

const noUnsafeEvalRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow eval, indirect eval, new Function, and string-evaluated timers in plugins',
    },
    messages: {
      noEval: 'Dynamic code evaluation ({{kind}}) is forbidden in Burrow plugins.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapTsNode(node.callee);
        if (callee?.type === 'Identifier') {
          if (callee.name === 'eval') {
            context.report({ node, messageId: 'noEval', data: { kind: 'eval()' } });
          } else if (callee.name === 'Function') {
            context.report({ node, messageId: 'noEval', data: { kind: 'Function()' } });
          } else if (callee.name === 'setTimeout' || callee.name === 'setInterval') {
            const firstArg = node.arguments[0];
            if (
              firstArg &&
              ((firstArg.type === 'Literal' && typeof firstArg.value === 'string') ||
                firstArg.type === 'TemplateLiteral')
            ) {
              context.report({
                node: firstArg,
                messageId: 'noEval',
                data: { kind: `${callee.name}(string)` },
              });
            }
          }
        } else if (callee?.type === 'MemberExpression') {
          const propName = callee.computed
            ? getStringLiteralValue(callee.property)
            : callee.property?.type === 'Identifier'
              ? callee.property.name
              : null;
          if (propName === 'eval' || (propName === 'Function' && GLOBAL_IDENTIFIERS.has(unwrapTsNode(callee.object)?.name))) {
            context.report({ node, messageId: 'noEval', data: { kind: `.${propName}()` } });
          }
        } else if (callee?.type === 'SequenceExpression') {
          const last = unwrapTsNode(callee.expressions[callee.expressions.length - 1]);
          if (last?.type === 'Identifier' && (last.name === 'eval' || last.name === 'Function')) {
            context.report({ node, messageId: 'noEval', data: { kind: `(..., ${last.name})()` } });
          }
        }
      },
      SequenceExpression(node) {
        const last = unwrapTsNode(node.expressions[node.expressions.length - 1]);
        if (last?.type === 'Identifier' && (last.name === 'eval' || last.name === 'Function')) {
          context.report({ node, messageId: 'noEval', data: { kind: `(..., ${last.name})` } });
        }
      },
      NewExpression(node) {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'Function') {
          context.report({ node, messageId: 'noEval', data: { kind: 'new Function()' } });
        }
      },
    };
  },
};

const noUnsanitizedHtmlRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow raw HTML sinks unless wrapped in sanitizePluginHtml()',
    },
    messages: {
      unsanitized:
        'Unsafe HTML sink "{{sink}}". Wrap untrusted HTML with sanitizePluginHtml(...) from @burrow/sdk.',
    },
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        if (
          node.left?.type === 'MemberExpression' &&
          !node.left.computed &&
          node.left.property?.type === 'Identifier' &&
          (node.left.property.name === 'innerHTML' || node.left.property.name === 'outerHTML')
        ) {
          if (!isSanitizerCall(node.right)) {
            context.report({
              node,
              messageId: 'unsanitized',
              data: { sink: node.left.property.name },
            });
          }
        }
      },
      CallExpression(node) {
        if (
          node.callee?.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property?.type === 'Identifier' &&
          node.callee.property.name === 'insertAdjacentHTML'
        ) {
          const htmlArg = node.arguments[1];
          if (!isSanitizerCall(htmlArg)) {
            context.report({
              node,
              messageId: 'unsanitized',
              data: { sink: 'insertAdjacentHTML' },
            });
          }
        }
      },
      JSXAttribute(node) {
        if (
          node.name?.type === 'JSXIdentifier' &&
          node.name.name === 'dangerouslySetInnerHTML'
        ) {
          const expr = node.value?.expression;
          if (expr?.type === 'ObjectExpression') {
            const htmlProp = expr.properties.find(
              (p) =>
                p.type === 'Property' &&
                !p.computed &&
                ((p.key?.type === 'Identifier' && p.key.name === '__html') ||
                  (p.key?.type === 'Literal' && p.key.value === '__html')),
            );
            if (htmlProp && isSanitizerCall(htmlProp.value)) {
              return;
            }
          }
          context.report({
            node,
            messageId: 'unsanitized',
            data: { sink: 'dangerouslySetInnerHTML' },
          });
        }
      },
    };
  },
};

const noRawFetchRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require ctx.fetch instead of global fetch() in plugins',
    },
    messages: {
      rawFetch:
        'Direct fetch() is disallowed in Burrow plugins; declare hostnames in manifest.network and call ctx.fetch(...).',
    },
  },
  create(context) {
    const fetchAliases = new Set();

    const isGlobalFetchExpr = (rawNode) => {
      const node = unwrapTsNode(rawNode);
      if (!node) return false;
      if (node.type === 'Identifier' && node.name === 'fetch') return true;
      if (node.type === 'MemberExpression') {
        const obj = unwrapTsNode(node.object);
        const propName = node.computed
          ? getStringLiteralValue(node.property)
          : node.property?.type === 'Identifier'
            ? node.property.name
            : null;
        if (propName === 'fetch' && obj?.type === 'Identifier' && GLOBAL_IDENTIFIERS.has(obj.name)) {
          return true;
        }
      }
      return false;
    };

    return {
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier' && isGlobalFetchExpr(node.init)) {
          fetchAliases.add(node.id.name);
        }
      },
      AssignmentExpression(node) {
        if (node.left?.type === 'Identifier' && isGlobalFetchExpr(node.right)) {
          fetchAliases.add(node.left.name);
        }
      },
      MemberExpression(node) {
        if (isGlobalFetchExpr(node)) {
          context.report({ node, messageId: 'rawFetch' });
        }
      },
      CallExpression(node) {
        const callee = unwrapTsNode(node.callee);
        if (callee?.type === 'Identifier' && (callee.name === 'fetch' || fetchAliases.has(callee.name))) {
          context.report({ node, messageId: 'rawFetch' });
        } else if (isGlobalFetchExpr(callee)) {
          context.report({ node, messageId: 'rawFetch' });
        }
      },
    };
  },
};

const noProcessEnvRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct process.env access in plugins; use ctx.config instead',
    },
    messages: {
      processEnv:
        'Direct process.env access is forbidden in plugins; declare keys in manifest.configKeys and read ctx.config.',
    },
  },
  create(context) {
    const processAliases = new Set(['process']);

    return {
      VariableDeclarator(node) {
        const init = unwrapTsNode(node.init);
        if (node.id?.type === 'Identifier' && init?.type === 'Identifier' && processAliases.has(init.name)) {
          processAliases.add(node.id.name);
        }
      },
      AssignmentExpression(node) {
        const right = unwrapTsNode(node.right);
        if (node.left?.type === 'Identifier' && right?.type === 'Identifier' && processAliases.has(right.name)) {
          processAliases.add(node.left.name);
        }
      },
      MemberExpression(node) {
        const obj = unwrapTsNode(node.object);
        if (obj?.type !== 'Identifier' || !processAliases.has(obj.name)) return;
        const propName = node.computed
          ? getStringLiteralValue(node.property)
          : node.property?.type === 'Identifier'
            ? node.property.name
            : null;
        if (propName === 'env') {
          context.report({ node, messageId: 'processEnv' });
        }
      },
    };
  },
};

const noStringSqlRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow string-concatenated or interpolated SQL passed to PluginDb methods',
    },
    messages: {
      stringSql:
        'String-built SQL is disallowed. Use parameterized placeholders (?, params) or the sql`...` tag from @burrow/sdk.',
    },
  },
  create(context) {
    const unsafeSqlVars = new Set();

    return {
      VariableDeclarator(node) {
        if (
          node.id?.type === 'Identifier' &&
          node.init &&
          ((node.init.type === 'TemplateLiteral' && node.init.expressions.length > 0) ||
            (node.init.type === 'BinaryExpression' && node.init.operator === '+'))
        ) {
          unsafeSqlVars.add(node.id.name);
        }
      },
      AssignmentExpression(node) {
        if (
          node.left?.type === 'Identifier' &&
          ((node.right.type === 'TemplateLiteral' && node.right.expressions.length > 0) ||
            (node.right.type === 'BinaryExpression' && node.right.operator === '+'))
        ) {
          unsafeSqlVars.add(node.left.name);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property?.type === 'Identifier' &&
          DB_EXEC_METHODS.has(callee.property.name)
        ) {
          const firstArg = node.arguments[0];
          if (containsUnsafeSqlExpression(firstArg, unsafeSqlVars)) {
            context.report({ node: firstArg, messageId: 'stringSql' });
          }
        }
      },
    };
  },
};

const noChildProcessRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow importing Node child_process, vm, inspector, or worker_threads',
    },
    messages: {
      blockedModule: 'Importing "{{mod}}" is forbidden in Burrow plugins.',
    },
  },
  create(context) {
    function checkSourceNode(node, sourceNode) {
      const mod = getStringLiteralValue(sourceNode);
      if (mod && BLOCKED_MODULES.has(mod)) {
        context.report({ node, messageId: 'blockedModule', data: { mod } });
      }
    }

    return {
      ImportDeclaration(node) {
        checkSourceNode(node, node.source);
      },
      ExportAllDeclaration(node) {
        checkSourceNode(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSourceNode(node, node.source);
      },
      ImportExpression(node) {
        checkSourceNode(node, node.source);
      },
      CallExpression(node) {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'require') {
          checkSourceNode(node, node.arguments[0]);
        }
      },
    };
  },
};

export const rules = {
  'no-unsafe-eval': noUnsafeEvalRule,
  'no-unsanitized-html': noUnsanitizedHtmlRule,
  'no-raw-fetch': noRawFetchRule,
  'no-process-env': noProcessEnvRule,
  'no-string-sql': noStringSqlRule,
  'no-child-process': noChildProcessRule,
};

export const burrowEslintPlugin = {
  meta: {
    name: '@burrow/eslint-plugin',
    version: '0.4.0',
  },
  rules,
};

export const recommendedRules = {
  '@burrow/no-unsafe-eval': 'error',
  '@burrow/no-unsanitized-html': 'error',
  '@burrow/no-raw-fetch': 'error',
  '@burrow/no-process-env': 'error',
  '@burrow/no-string-sql': 'error',
  '@burrow/no-child-process': 'error',
};

export const configs = {
  recommended: [
    {
      plugins: {
        '@burrow': burrowEslintPlugin,
      },
      rules: recommendedRules,
    },
  ],
};

export default burrowEslintPlugin;
