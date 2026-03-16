/**
 * @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigArray}
 */
const eslintPluginN8nNodesBase = require('eslint-plugin-n8n-nodes-base');

module.exports = [
  ...eslintPluginN8nNodesBase.configs.nodes,
  {
    rules: {
      'n8n-nodes-base/node-param-description-missing-final-period': 'off',
    },
  },
];
