/*
* Copyright Broadcom, Inc. All Rights Reserved.
* SPDX-License-Identifier: Apache-2.0
*/

/* eslint-disable no-restricted-syntax */

const fs = require('fs');
const dot = require('dot-object');
const YAML = require('yaml');
const _ = require('lodash');

const utils = require('./utils');
const Parameter = require('./parameter');
const Section = require('./section');
const Metadata = require('./metadata');

/*
 * Helper function to detect YAML key and indentation level from a line
 */
function parseYamlLine(line) {
  const yamlKeyRegex = /^(\s*)([^#\s][^:]*?):\s*(.*)$/;
  const match = line.match(yamlKeyRegex);

  if (match) {
    const indent = match[1].length;
    const key = match[2].trim();
    const value = match[3].trim();
    const isComment = line.trim().startsWith('#');

    return {
      isYamlKey: !isComment,
      indent,
      key,
      value,
      hasValue: value !== '' && value !== '{}' && value !== '[]'
    };
  }

  return { isYamlKey: false };
}

/*
 * Helper function to build current path from path stack
 */
function buildCurrentPath(pathStack) {
  return pathStack.length > 0 ? pathStack.join('.') : '';
}

/*
 * Helper function to update path stack based on current indentation
 */
function updatePathStack(pathStack, indentStack, currentIndent, key) {
  // Remove entries with deeper indentation
  while (indentStack.length > 0 && indentStack[indentStack.length - 1] >= currentIndent) {
    indentStack.pop();
    pathStack.pop();
  }

  // Add current key to path
  indentStack.push(currentIndent);
  pathStack.push(key);
}

/*
 * Returns a Metadata object
 * The objects within that wrapper object are parsed from the comments metadata
 * See metadata.js
 */
function parseMetadataComments(valuesFilePath, config) {
  /*  eslint-disable prefer-destructuring */

  const data = fs.readFileSync(valuesFilePath, 'UTF-8');
  const lines = data.split(/\r?\n/);

  const parsedValues = new Metadata();
  const paramRegex = new RegExp(`^\\s*${config.comments.format}\\s*${config.tags.param}\\s*(?:\\(([^\\s]+)\\))?\\s*(\\[.*?\\])?\\s*(.*)$`);
  const sectionRegex = new RegExp(`^\\s*${config.comments.format}\\s*${config.tags.section}\\s*(.*)$`);
  const descriptionStartRegex = new RegExp(`^\\s*${config.comments.format}\\s*${config.tags.descriptionStart}\\s*(.*)`);
  const descriptionContentRegex = new RegExp(`^\\s*${config.comments.format}\\s?(.*)`);
  const descriptionEndRegex = new RegExp(`^\\s*${config.comments.format}\\s*${config.tags.descriptionEnd}\\s*(.*)`);
  const skipRegex = new RegExp(`^\\s*${config.comments.format}\\s*${config.tags.skip}\\s*(?:\\(([^\\s]+)\\))?\\s*(.*)$`);
  const extraRegex = new RegExp(`^\\s*${config.comments.format}\\s*${config.tags.extra}\\s*(?:\\(([^\\s]+)\\))?\\s*(\\[.*?\\])?\\s*(.*)$`);

  // We assume there will always be a section before any parameter. At least one section is required
  let currentSection = null;
  let descriptionParsing = false;

  // Path tracking for automatic path detection
  let pathStack = []; // Stack to track the current YAML path
  let indentStack = []; // Stack to track indentation levels
  let pendingParam = null; // Parameter waiting for path detection

  lines.forEach((line, lineIndex) => {
    // Parse YAML structure to track current path context
    const yamlInfo = parseYamlLine(line);
    if (yamlInfo.isYamlKey) {
      updatePathStack(pathStack, indentStack, yamlInfo.indent, yamlInfo.key);

      // If we had a pending parameter from the previous comment, assign it the current path
      if (pendingParam) {
        pendingParam.name = buildCurrentPath(pathStack);
        if (currentSection) {
          pendingParam.section = currentSection.name;
          currentSection.addParameter(pendingParam);
        }
        parsedValues.addParameter(pendingParam);
        pendingParam = null;
      }
    }

    // Parse param line
    const paramMatch = line.match(paramRegex);
    if (paramMatch && paramMatch.length > 0) {
      const explicitPath = paramMatch[1]; // This will be undefined if path is omitted
      const modifiers = paramMatch[2] ? paramMatch[2].split('[')[1].split(']')[0] : '';
      const description = paramMatch[3];

      if (explicitPath) {
        // Traditional behavior: explicit path provided
        const param = new Parameter(explicitPath);
        param.modifiers = modifiers.split(',').filter((m) => m).map((m) => m.trim());
        param.description = description;
        if (currentSection) {
          param.section = currentSection.name;
          currentSection.addParameter(param);
        }
        parsedValues.addParameter(param);
      } else {
        // New behavior: auto-detect path
        // Create parameter without path and wait for next YAML key
        pendingParam = new Parameter(''); // Will be set later
        pendingParam.modifiers = modifiers.split(',').filter((m) => m).map((m) => m.trim());
        pendingParam.description = description;

        // Look ahead to see if next line has a YAML key
        if (lineIndex + 1 < lines.length) {
          const nextLine = lines[lineIndex + 1];
          const nextYamlInfo = parseYamlLine(nextLine);
          if (nextYamlInfo.isYamlKey) {
            // Build path for the next key
            const tempPathStack = [...pathStack];
            const tempIndentStack = [...indentStack];
            updatePathStack(tempPathStack, tempIndentStack, nextYamlInfo.indent, nextYamlInfo.key);
            pendingParam.name = buildCurrentPath(tempPathStack);

            if (currentSection) {
              pendingParam.section = currentSection.name;
              currentSection.addParameter(pendingParam);
            }
            parsedValues.addParameter(pendingParam);
            pendingParam = null;
          }
        }
      }
    }

    // Parse section line
    const sectionMatch = line.match(sectionRegex);
    if (sectionMatch && sectionMatch.length > 0) {
      const section = new Section(sectionMatch[1]);
      parsedValues.addSection(section);
      currentSection = section;
    }

    // Parse section description end line
    const descriptionEndMatch = line.match(descriptionEndRegex);
    if (currentSection && descriptionParsing && descriptionEndMatch) {
      descriptionParsing = false;
    }

    // Parse section description content line between start and end
    const descriptionContentMatch = line.match(descriptionContentRegex);
    if (currentSection && descriptionParsing
        && descriptionContentMatch && descriptionContentMatch.length > 0) {
      currentSection.addDescriptionLine(descriptionContentMatch[1]);
    }

    // Parse section description start line
    const descriptionStartMatch = line.match(descriptionStartRegex);
    if (currentSection && !descriptionParsing && descriptionStartMatch) {
      descriptionParsing = true;
      if (descriptionStartMatch.length > 0 && descriptionStartMatch[1] !== '') {
        currentSection.addDescriptionLine(descriptionStartMatch[1]);
      }
    }

    // Parse skip line with auto-path detection
    const skipMatch = line.match(skipRegex);
    if (skipMatch && skipMatch.length > 0) {
      const explicitPath = skipMatch[1]; // This will be undefined if path is omitted
      const description = skipMatch[2];

      if (explicitPath) {
        // Traditional behavior: explicit path provided
        const param = new Parameter(explicitPath);
        param.skip = true;
        param.description = description;
        if (currentSection) {
          param.section = currentSection.name;
          currentSection.addParameter(param);
        }
        parsedValues.addParameter(param);
      } else {
        // New behavior: auto-detect path
        // Create parameter without path and wait for next YAML key
        pendingParam = new Parameter(''); // Will be set later
        pendingParam.skip = true;
        pendingParam.description = description;

        // Look ahead to see if next line has a YAML key
        if (lineIndex + 1 < lines.length) {
          const nextLine = lines[lineIndex + 1];
          const nextYamlInfo = parseYamlLine(nextLine);
          if (nextYamlInfo.isYamlKey) {
            // Build path for the next key
            const tempPathStack = [...pathStack];
            const tempIndentStack = [...indentStack];
            updatePathStack(tempPathStack, tempIndentStack, nextYamlInfo.indent, nextYamlInfo.key);
            pendingParam.name = buildCurrentPath(tempPathStack);

            if (currentSection) {
              pendingParam.section = currentSection.name;
              currentSection.addParameter(pendingParam);
            }
            parsedValues.addParameter(pendingParam);
            pendingParam = null;
          }
        }
      }
    }

    // Parse extra line with auto-path detection
    const extraMatch = line.match(extraRegex);
    if (extraMatch && extraMatch.length > 0) {
      const explicitPath = extraMatch[1]; // This will be undefined if path is omitted
      const modifiers = extraMatch[2] ? extraMatch[2].split('[')[1].split(']')[0] : '';
      const description = extraMatch[3];

      if (explicitPath) {
        // Traditional behavior: explicit path provided
        const param = new Parameter(explicitPath);
        param.modifiers = modifiers.split(',').filter((m) => m).map((m) => m.trim());
        param.description = description;
        param.value = ''; // Set an empty string by default since it won't have a value in the actual YAML
        param.extra = true;
        if (currentSection) {
          param.section = currentSection.name;
          currentSection.addParameter(param);
        }
        parsedValues.addParameter(param);
      } else {
        // New behavior: auto-detect path
        // Create parameter without path and wait for next YAML key
        pendingParam = new Parameter(''); // Will be set later
        pendingParam.modifiers = modifiers.split(',').filter((m) => m).map((m) => m.trim());
        pendingParam.description = description;
        pendingParam.value = ''; // Set an empty string by default since it won't have a value in the actual YAML
        pendingParam.extra = true;

        // Look ahead to see if next line has a YAML key
        if (lineIndex + 1 < lines.length) {
          const nextLine = lines[lineIndex + 1];
          const nextYamlInfo = parseYamlLine(nextLine);
          if (nextYamlInfo.isYamlKey) {
            // Build path for the next key
            const tempPathStack = [...pathStack];
            const tempIndentStack = [...indentStack];
            updatePathStack(tempPathStack, tempIndentStack, nextYamlInfo.indent, nextYamlInfo.key);
            pendingParam.name = buildCurrentPath(tempPathStack);

            if (currentSection) {
              pendingParam.section = currentSection.name;
              currentSection.addParameter(pendingParam);
            }
            parsedValues.addParameter(pendingParam);
            pendingParam = null;
          }
        }
      }
    }
  });

  return parsedValues;
}


/*
 * Returns an array of Parameters parsed from the actual YAML content
 * This object contains the actual type and value of the object
 */
function createValuesObject(valuesFilePath) {
  const resultValues = [];
  const valuesJSON = YAML.parse(fs.readFileSync(valuesFilePath, 'utf8'));
  const dottedFormatProperties = dot.dot(valuesJSON);

  for (let valuePath in dottedFormatProperties) {
    if (Object.prototype.hasOwnProperty.call(dottedFormatProperties, valuePath)) {
      let value = _.get(valuesJSON, valuePath);
      // TODO(miguelaeh):
      // Variable to avoid render in the schema parameters with dots in the keys.
      // the ocurrences of this variable inside this function must be deleted after fixing it.
      let renderInSchema = true;
      if (value === undefined) {
        // If the value is not found,
        // give a try to our function for complex keys like 'annotations.prometheus.io/scrape'
        value = _.get(valuesJSON, utils.getArrayPath(valuesJSON, valuePath));
        renderInSchema = false;
      }
      let type = typeof value;

      // Check if the value is a plain array, an array that only contains strings,
      // those strings should not have metadata, the metadata must exist for the array itself
      const valuePathSplit = valuePath.split('[');
      if (valuePathSplit.length > 1) {
        // The value is inside an array
        const arrayPrefix = utils.getArrayPrefix(valuePath);
        let isPlainArray = true; // Assume it is plain until we prove the opposite
        _.get(valuesJSON, utils.getArrayPath(valuesJSON, arrayPrefix)).forEach((e) => {
          if (typeof e !== 'string') {
            isPlainArray = false;
          }
        });
        if (isPlainArray) {
          value = _.get(valuesJSON, utils.getArrayPath(valuesJSON, arrayPrefix));
          valuePath = arrayPrefix;
        }
      }

      // Map the javascript 'null' to golang 'nil'
      if (value === null) {
        value = 'nil';
      }

      // When an element is an object it can be object or array
      if (typeof value === 'object') {
        if (Array.isArray(value)) {
          type = 'array';
        }
      }

      // The existence check is needed to avoid duplicate plain array keys
      if (!resultValues.find((v) => v.name === valuePath)) {
        const param = new Parameter(valuePath);
        if (!param.value) param.value = value;
        param.type = type;
        param.schema = renderInSchema;
        resultValues.push(param);
      }
    }
  }

  return resultValues;
}

module.exports = {
  parseMetadataComments,
  createValuesObject,
};
