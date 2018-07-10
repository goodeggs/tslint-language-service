"use strict";
const path = require("path");
const mockRequire = require("mock-require");
const minimatch = require("minimatch");
const TSLINT_ERROR_CODE = 100000;
function init(modules) {
    const ts = modules.typescript;
    let codeFixActions = new Map();
    let registeredCodeFixes = false;
    let configCache = {
        filePath: null,
        configuration: null,
        isDefaultConfig: false,
        configFilePath: null
    };
    // Work around the lack of API to register a CodeFix
    function registerCodeFix(action) {
        return ts.codefix.registerCodeFix(action);
    }
    if (!registeredCodeFixes && ts && ts.codefix) {
        registerCodeFixes(registerCodeFix);
        registeredCodeFixes = true;
    }
    function registerCodeFixes(registerCodeFix) {
        // Code fix for that is used for all tslint fixes
        registerCodeFix({
            errorCodes: [TSLINT_ERROR_CODE],
            getCodeActions: (_context) => {
                return null;
            }
        });
    }
    function fixRelativeConfigFilePath(config, projectRoot) {
        if (!config.configFile) {
            return config;
        }
        if (path.isAbsolute(config.configFile)) {
            return config;
        }
        config.configFile = path.join(projectRoot, config.configFile);
        return config;
    }
    function create(info) {
        info.project.projectService.logger.info("tslint-language-service loaded");
        let config = fixRelativeConfigFilePath(info.config, info.project.getCurrentDirectory());
        let configuration = null;
        if (config.mockTypeScriptVersion) {
            mockRequire('typescript', ts);
        }
        const tslint = require('tslint');
        // Set up decorator
        const proxy = Object.create(null);
        const oldLS = info.languageService;
        for (const k in oldLS) {
            proxy[k] = function () {
                return oldLS[k].apply(oldLS, arguments);
            };
        }
        // key to identify a rule failure
        function computeKey(start, end) {
            return `[${start},${end}]`;
        }
        function makeDiagnostic(problem, file) {
            let message = (problem.getRuleName() !== null)
                ? `${problem.getFailure()} (${problem.getRuleName()})`
                : `${problem.getFailure()}`;
            let category;
            if (config.alwaysShowRuleFailuresAsWarnings === true) {
                category = ts.DiagnosticCategory.Warning;
            }
            else if (problem.getRuleSeverity && problem.getRuleSeverity() === 'error') {
                // tslint5 supports to assign severities to rules
                category = ts.DiagnosticCategory.Error;
            }
            else {
                category = ts.DiagnosticCategory.Warning;
            }
            let diagnostic = {
                file: file,
                start: problem.getStartPosition().getPosition(),
                length: problem.getEndPosition().getPosition() - problem.getStartPosition().getPosition(),
                messageText: message,
                category: category,
                source: 'tslint',
                code: TSLINT_ERROR_CODE
            };
            return diagnostic;
        }
        /**
         * Filter failures for the given document
         */
        function filterProblemsForDocument(documentPath, failures) {
            let normalizedPath = path.normalize(documentPath);
            // we only show diagnostics targetting this open document, some tslint rule return diagnostics for other documents/files
            let normalizedFiles = new Map();
            return failures.filter(each => {
                let fileName = each.getFileName();
                if (!normalizedFiles.has(fileName)) {
                    normalizedFiles.set(fileName, path.normalize(fileName));
                }
                return normalizedFiles.get(fileName) === normalizedPath;
            });
        }
        function replacementsAreEmpty(fix) {
            // in tslint 4 a Fix has a replacement property witht the Replacements
            if (fix.replacements) {
                return fix.replacements.length === 0;
            }
            // tslint 5
            if (Array.isArray(fix)) {
                return fix.length === 0;
            }
            return false;
        }
        function recordCodeAction(problem, file) {
            let fix = null;
            // tslint can return a fix with an empty replacements array, these fixes are ignored
            if (problem.getFix && problem.getFix() && !replacementsAreEmpty(problem.getFix())) { // tslint fixes are not available in tslint < 3.17
                fix = problem.getFix(); // createAutoFix(problem, document, problem.getFix());
            }
            if (!fix) {
                return;
            }
            let documentAutoFixes = codeFixActions.get(file.fileName);
            if (!documentAutoFixes) {
                documentAutoFixes = new Map();
                codeFixActions.set(file.fileName, documentAutoFixes);
            }
            documentAutoFixes.set(computeKey(problem.getStartPosition().getPosition(), problem.getEndPosition().getPosition()), problem);
        }
        function getConfigurationFailureMessage(err) {
            let errorMessage = `unknown error`;
            if (typeof err.message === 'string' || err.message instanceof String) {
                errorMessage = err.message;
            }
            return `tslint: Cannot read tslint configuration - '${errorMessage}'`;
        }
        function getConfiguration(filePath, configFileName) {
            if (configCache.configuration && configCache.filePath === filePath) {
                return configCache.configuration;
            }
            let isDefaultConfig = false;
            let configuration;
            let configFilePath = null;
            isDefaultConfig = tslint.Configuration.findConfigurationPath(configFileName, filePath) === undefined;
            let configurationResult = tslint.Configuration.findConfiguration(configFileName, filePath);
            // between tslint 4.0.1 and tslint 4.0.2 the attribute 'error' has been removed from IConfigurationLoadResult
            // in 4.0.2 findConfiguration throws an exception as in version ^3.0.0
            if (configurationResult.error) {
                throw configurationResult.error;
            }
            configuration = configurationResult.results;
            // In tslint version 5 the 'no-unused-variable' rules breaks the TypeScript language service plugin.
            // See https://github.com/Microsoft/TypeScript/issues/15344
            // Therefore we remove the rule from the configuration.
            //
            // In tslint 5 the rules are stored in a Map, in earlier versions they were stored in an Object
            if (config.disableNoUnusedVariableRule === true || config.disableNoUnusedVariableRule === undefined) {
                if (configuration.rules && configuration.rules instanceof Map) {
                    configuration.rules.delete('no-unused-variable');
                }
                if (configuration.jsRules && configuration.jsRules instanceof Map) {
                    configuration.jsRules.delete('no-unused-variable');
                }
            }
            configFilePath = configurationResult.path;
            configCache = {
                filePath: filePath,
                isDefaultConfig: isDefaultConfig,
                configuration: configuration,
                configFilePath: configFilePath
            };
            return configCache.configuration;
        }
        function captureWarnings(message) {
            // TODO log to a user visible log and not only the TS-Server log
            info.project.projectService.logger.info(`[tslint] ${message}`);
        }
        function convertReplacementToTextChange(repl) {
            return {
                newText: repl.text,
                span: { start: repl.start, length: repl.length }
            };
        }
        function getReplacements(fix) {
            let replacements = null;
            // in tslint4 a Fix has a replacement property with the Replacements
            if (fix.replacements) {
                // tslint4
                replacements = fix.replacements;
            }
            else {
                // in tslint 5 a Fix is a Replacement | Replacement[]                  
                if (!Array.isArray(fix)) {
                    replacements = [fix];
                }
                else {
                    replacements = fix;
                }
            }
            return replacements;
        }
        function problemToFileTextChange(problem, fileName) {
            let fix = problem.getFix();
            let replacements = getReplacements(fix);
            return {
                fileName: fileName,
                textChanges: replacements.map(each => convertReplacementToTextChange(each)),
            };
        }
        function addRuleFailureFix(fixes, problem, fileName) {
            fixes.push({
                description: `Fix '${problem.getRuleName()}'`,
                changes: [problemToFileTextChange(problem, fileName)]
            });
        }
        /* Generate a code action that fixes all instances of ruleName.  */
        function addRuleFailureFixAll(fixes, ruleName, problems, fileName) {
            const changes = [];
            for (const problem of problems.values()) {
                if (problem.getRuleName() === ruleName) {
                    changes.push(problemToFileTextChange(problem, fileName));
                }
            }
            /* No need for this action if there's only one instance.  */
            if (changes.length < 2) {
                return;
            }
            fixes.push({
                description: `Fix all '${ruleName}'`,
                changes: changes,
            });
        }
        function addDisableRuleFix(fixes, problem, fileName, file) {
            fixes.push({
                description: `Disable rule '${problem.getRuleName()}'`,
                changes: [{
                        fileName: fileName,
                        textChanges: [{
                                newText: `// tslint:disable-next-line:${problem.getRuleName()}\n`,
                                span: { start: file.getLineStarts()[problem.getStartPosition().getLineAndCharacter().line], length: 0 }
                            }]
                    }]
            });
        }
        function addOpenConfigurationFix(fixes) {
            // the Open Configuration code action is disabled since there is no specified API to open an editor
            let openConfigFixEnabled = false;
            if (openConfigFixEnabled && configCache && configCache.configFilePath) {
                fixes.push({
                    description: `Open tslint.json`,
                    changes: [{
                            fileName: configCache.configFilePath,
                            textChanges: []
                        }]
                });
            }
        }
        function addAllAutoFixable(fixes, documentFixes, fileName) {
            const allReplacements = getNonOverlappingReplacements(documentFixes);
            fixes.push({
                description: `Fix all auto-fixable tslint failures`,
                changes: [{
                        fileName: fileName,
                        textChanges: allReplacements.map(each => convertReplacementToTextChange(each))
                    }]
            });
        }
        function getReplacement(failure, at) {
            return getReplacements(failure.getFix())[at];
        }
        function sortFailures(failures) {
            // The failures.replacements are sorted by position, we sort on the position of the first replacement
            return failures.sort((a, b) => {
                return getReplacement(a, 0).start - getReplacement(b, 0).start;
            });
        }
        function getNonOverlappingReplacements(documentFixes) {
            function overlaps(a, b) {
                return a.end >= b.start;
            }
            let sortedFailures = sortFailures([...documentFixes.values()]);
            let nonOverlapping = [];
            for (let i = 0; i < sortedFailures.length; i++) {
                let replacements = getReplacements(sortedFailures[i].getFix());
                if (i === 0 || !overlaps(nonOverlapping[nonOverlapping.length - 1], replacements[0])) {
                    nonOverlapping.push(...replacements);
                }
            }
            return nonOverlapping;
        }
        proxy.getSemanticDiagnostics = (fileName) => {
            const prior = oldLS.getSemanticDiagnostics(fileName);
            if (config.supressWhileTypeErrorsPresent && prior.length > 0) {
                return prior;
            }
            try {
                info.project.projectService.logger.info(`Computing tslint semantic diagnostics...`);
                if (codeFixActions.has(fileName)) {
                    codeFixActions.delete(fileName);
                }
                if (config.ignoreDefinitionFiles === true && fileName.endsWith('.d.ts')) {
                    return prior;
                }
                try {
                    configuration = getConfiguration(fileName, config.configFile);
                    if (configuration.linterOptions &&
                        configuration.linterOptions.exclude &&
                        configuration.linterOptions.exclude.some(function (pattern) { return new minimatch.Minimatch(pattern).match(fileName); })) {
                        return prior;
                    }
                }
                catch (err) {
                    // TODO: show the reason for the configuration failure to the user and not only in the log
                    // https://github.com/Microsoft/TypeScript/issues/15913
                    info.project.projectService.logger.info(getConfigurationFailureMessage(err));
                    return prior;
                }
                let result;
                // tslint writes warning messages using console.warn()
                // capture the warnings and write them to the tslint plugin log
                let warn = console.warn;
                console.warn = captureWarnings;
                try { // protect against tslint crashes
                    // TODO the types of the Program provided by tsserver libary are not compatible with the one provided by typescript
                    // casting away the type
                    let options = { fix: false };
                    let linter = new tslint.Linter(options, oldLS.getProgram());
                    linter.lint(fileName, "", configuration);
                    result = linter.getResult();
                }
                catch (err) {
                    let errorMessage = `unknown error`;
                    if (typeof err.message === 'string' || err.message instanceof String) {
                        errorMessage = err.message;
                    }
                    info.project.projectService.logger.info('tslint error ' + errorMessage);
                    return prior;
                }
                finally {
                    console.warn = warn;
                }
                if (result.failures.length > 0) {
                    const tslintProblems = filterProblemsForDocument(fileName, result.failures);
                    if (tslintProblems && tslintProblems.length) {
                        const file = oldLS.getProgram().getSourceFile(fileName);
                        const diagnostics = prior ? [...prior] : [];
                        tslintProblems.forEach(problem => {
                            diagnostics.push(makeDiagnostic(problem, file));
                            recordCodeAction(problem, file);
                        });
                        return diagnostics;
                    }
                }
            }
            catch (e) {
                info.project.projectService.logger.info(`tslint-language service error: ${e.toString()}`);
                info.project.projectService.logger.info(`Stack trace: ${e.stack}`);
            }
            return prior;
        };
        proxy.getCodeFixesAtPosition = function (fileName, start, end, errorCodes, formatOptions, preferences) {
            let prior = oldLS.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences);
            if (config.supressWhileTypeErrorsPresent && prior.length > 0) {
                return prior;
            }
            info.project.projectService.logger.info("tslint-language-service getCodeFixes " + errorCodes[0]);
            let documentFixes = codeFixActions.get(fileName);
            if (documentFixes) {
                const fixes = prior ? [...prior] : [];
                let problem = documentFixes.get(computeKey(start, end));
                if (problem) {
                    addRuleFailureFix(fixes, problem, fileName);
                    addRuleFailureFixAll(fixes, problem.getRuleName(), documentFixes, fileName);
                }
                addAllAutoFixable(fixes, documentFixes, fileName);
                if (problem) {
                    addOpenConfigurationFix(fixes);
                    addDisableRuleFix(fixes, problem, fileName, oldLS.getProgram().getSourceFile(fileName));
                }
                return fixes;
            }
            return prior;
        };
        return proxy;
    }
    return { create };
}
module.exports = init;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUVBLDZCQUE2QjtBQUM3Qiw0Q0FBNEM7QUFDNUMsdUNBQXVDO0FBWXZDLE1BQU0saUJBQWlCLEdBQUcsTUFBTSxDQUFDO0FBRWpDLGNBQWMsT0FBeUM7SUFDbkQsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLFVBQVUsQ0FBQztJQUU5QixJQUFJLGNBQWMsR0FBRyxJQUFJLEdBQUcsRUFBMkMsQ0FBQztJQUN4RSxJQUFJLG1CQUFtQixHQUFHLEtBQUssQ0FBQztJQUVoQyxJQUFJLFdBQVcsR0FBRztRQUNkLFFBQVEsRUFBVSxJQUFJO1FBQ3RCLGFBQWEsRUFBTyxJQUFJO1FBQ3hCLGVBQWUsRUFBRSxLQUFLO1FBQ3RCLGNBQWMsRUFBVSxJQUFJO0tBQy9CLENBQUM7SUFFRixvREFBb0Q7SUFDcEQseUJBQXlCLE1BQXVCO1FBQzVDLE9BQVEsRUFBVSxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkQsQ0FBQztJQUVELElBQUksQ0FBQyxtQkFBbUIsSUFBSSxFQUFFLElBQUssRUFBVSxDQUFDLE9BQU8sRUFBRTtRQUNuRCxpQkFBaUIsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUNuQyxtQkFBbUIsR0FBRyxJQUFJLENBQUM7S0FDOUI7SUFFRCwyQkFBMkIsZUFBa0Q7UUFDekUsaURBQWlEO1FBQ2pELGVBQWUsQ0FBQztZQUNaLFVBQVUsRUFBRSxDQUFDLGlCQUFpQixDQUFDO1lBQy9CLGNBQWMsRUFBRSxDQUFDLFFBQWEsRUFBRSxFQUFFO2dCQUM5QixPQUFPLElBQUksQ0FBQztZQUNoQixDQUFDO1NBQ0osQ0FBQyxDQUFDO0lBQ1AsQ0FBQztJQUVELG1DQUFtQyxNQUFnQixFQUFFLFdBQW1CO1FBQ3BFLElBQUksQ0FBQyxNQUFNLENBQUMsVUFBVSxFQUFFO1lBQ3BCLE9BQU8sTUFBTSxDQUFDO1NBQ2pCO1FBQ0QsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsRUFBRTtZQUNwQyxPQUFPLE1BQU0sQ0FBQztTQUNqQjtRQUNELE1BQU0sQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQzlELE9BQU8sTUFBTSxDQUFDO0lBQ2xCLENBQUM7SUFFRCxnQkFBZ0IsSUFBZ0M7UUFDNUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxnQ0FBZ0MsQ0FBQyxDQUFDO1FBQzFFLElBQUksTUFBTSxHQUFhLHlCQUF5QixDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxtQkFBbUIsRUFBRSxDQUFDLENBQUM7UUFDbEcsSUFBSSxhQUFhLEdBQTRDLElBQUksQ0FBQztRQUVsRSxJQUFHLE1BQU0sQ0FBQyxxQkFBcUIsRUFBRTtZQUM3QixXQUFXLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1NBQ2pDO1FBQ0QsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFBO1FBRWhDLG1CQUFtQjtRQUNuQixNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBdUIsQ0FBQztRQUN4RCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDO1FBQ25DLEtBQUssTUFBTSxDQUFDLElBQUksS0FBSyxFQUFFO1lBQ2IsS0FBTSxDQUFDLENBQUMsQ0FBQyxHQUFHO2dCQUNkLE9BQWEsS0FBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsU0FBUyxDQUFDLENBQUM7WUFDbkQsQ0FBQyxDQUFBO1NBQ0o7UUFFRCxpQ0FBaUM7UUFDakMsb0JBQW9CLEtBQWEsRUFBRSxHQUFXO1lBQzFDLE9BQU8sSUFBSSxLQUFLLElBQUksR0FBRyxHQUFHLENBQUM7UUFDL0IsQ0FBQztRQUVELHdCQUF3QixPQUEyQixFQUFFLElBQW1CO1lBQ3BFLElBQUksT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLFdBQVcsRUFBRSxLQUFLLElBQUksQ0FBQztnQkFDMUMsQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDLFVBQVUsRUFBRSxLQUFLLE9BQU8sQ0FBQyxXQUFXLEVBQUUsR0FBRztnQkFDdEQsQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDLFVBQVUsRUFBRSxFQUFFLENBQUM7WUFFaEMsSUFBSSxRQUFRLENBQUM7WUFDYixJQUFJLE1BQU0sQ0FBQyxnQ0FBZ0MsS0FBSyxJQUFJLEVBQUU7Z0JBQ2xELFFBQVEsR0FBRyxFQUFFLENBQUMsa0JBQWtCLENBQUMsT0FBTyxDQUFDO2FBQzVDO2lCQUFNLElBQVUsT0FBUSxDQUFDLGVBQWUsSUFBVSxPQUFRLENBQUMsZUFBZSxFQUFFLEtBQUssT0FBTyxFQUFFO2dCQUN2RixpREFBaUQ7Z0JBQ2pELFFBQVEsR0FBRyxFQUFFLENBQUMsa0JBQWtCLENBQUMsS0FBSyxDQUFDO2FBQzFDO2lCQUFNO2dCQUNILFFBQVEsR0FBRyxFQUFFLENBQUMsa0JBQWtCLENBQUMsT0FBTyxDQUFDO2FBQzVDO1lBRUQsSUFBSSxVQUFVLEdBQWtCO2dCQUM1QixJQUFJLEVBQUUsSUFBSTtnQkFDVixLQUFLLEVBQUUsT0FBTyxDQUFDLGdCQUFnQixFQUFFLENBQUMsV0FBVyxFQUFFO2dCQUMvQyxNQUFNLEVBQUUsT0FBTyxDQUFDLGNBQWMsRUFBRSxDQUFDLFdBQVcsRUFBRSxHQUFHLE9BQU8sQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDLFdBQVcsRUFBRTtnQkFDekYsV0FBVyxFQUFFLE9BQU87Z0JBQ3BCLFFBQVEsRUFBRSxRQUFRO2dCQUNsQixNQUFNLEVBQUUsUUFBUTtnQkFDaEIsSUFBSSxFQUFFLGlCQUFpQjthQUMxQixDQUFDO1lBQ0YsT0FBTyxVQUFVLENBQUM7UUFDdEIsQ0FBQztRQUVEOztXQUVHO1FBQ0gsbUNBQW1DLFlBQW9CLEVBQUUsUUFBOEI7WUFDbkYsSUFBSSxjQUFjLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUNsRCx3SEFBd0g7WUFDeEgsSUFBSSxlQUFlLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7WUFDaEQsT0FBTyxRQUFRLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxFQUFFO2dCQUMxQixJQUFJLFFBQVEsR0FBRyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7Z0JBQ2xDLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxFQUFFO29CQUNoQyxlQUFlLENBQUMsR0FBRyxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7aUJBQzNEO2dCQUNELE9BQU8sZUFBZSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsS0FBSyxjQUFjLENBQUM7WUFDNUQsQ0FBQyxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsOEJBQThCLEdBQWU7WUFDekMsc0VBQXNFO1lBQ3RFLElBQVUsR0FBSSxDQUFDLFlBQVksRUFBRTtnQkFDekIsT0FBYSxHQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUM7YUFDL0M7WUFDRCxXQUFXO1lBQ1gsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFO2dCQUNwQixPQUFPLEdBQUcsQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDO2FBQzNCO1lBQ0QsT0FBTyxLQUFLLENBQUM7UUFDakIsQ0FBQztRQUVELDBCQUEwQixPQUEyQixFQUFFLElBQW1CO1lBQ3RFLElBQUksR0FBRyxHQUFlLElBQUksQ0FBQztZQUUzQixvRkFBb0Y7WUFDcEYsSUFBSSxPQUFPLENBQUMsTUFBTSxJQUFJLE9BQU8sQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLG9CQUFvQixDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUUsa0RBQWtEO2dCQUNuSSxHQUFHLEdBQUcsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsc0RBQXNEO2FBQ2pGO1lBRUQsSUFBSSxDQUFDLEdBQUcsRUFBRTtnQkFDTixPQUFPO2FBQ1Y7WUFFRCxJQUFJLGlCQUFpQixHQUFvQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUMzRixJQUFJLENBQUMsaUJBQWlCLEVBQUU7Z0JBQ3BCLGlCQUFpQixHQUFHLElBQUksR0FBRyxFQUE4QixDQUFDO2dCQUMxRCxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsaUJBQWlCLENBQUMsQ0FBQzthQUN4RDtZQUNELGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLGdCQUFnQixFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUUsT0FBTyxDQUFDLGNBQWMsRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDakksQ0FBQztRQUVELHdDQUF3QyxHQUFRO1lBQzVDLElBQUksWUFBWSxHQUFHLGVBQWUsQ0FBQztZQUNuQyxJQUFJLE9BQU8sR0FBRyxDQUFDLE9BQU8sS0FBSyxRQUFRLElBQUksR0FBRyxDQUFDLE9BQU8sWUFBWSxNQUFNLEVBQUU7Z0JBQ2xFLFlBQVksR0FBVyxHQUFHLENBQUMsT0FBTyxDQUFDO2FBQ3RDO1lBQ0QsT0FBTywrQ0FBK0MsWUFBWSxHQUFHLENBQUM7UUFDMUUsQ0FBQztRQUVELDBCQUEwQixRQUFnQixFQUFFLGNBQXNCO1lBQzlELElBQUksV0FBVyxDQUFDLGFBQWEsSUFBSSxXQUFXLENBQUMsUUFBUSxLQUFLLFFBQVEsRUFBRTtnQkFDaEUsT0FBTyxXQUFXLENBQUMsYUFBYSxDQUFDO2FBQ3BDO1lBRUQsSUFBSSxlQUFlLEdBQUcsS0FBSyxDQUFDO1lBQzVCLElBQUksYUFBYSxDQUFDO1lBQ2xCLElBQUksY0FBYyxHQUFHLElBQUksQ0FBQztZQUUxQixlQUFlLEdBQUcsTUFBTSxDQUFDLGFBQWEsQ0FBQyxxQkFBcUIsQ0FBQyxjQUFjLEVBQUUsUUFBUSxDQUFDLEtBQUssU0FBUyxDQUFDO1lBQ3JHLElBQUksbUJBQW1CLEdBQUcsTUFBTSxDQUFDLGFBQWEsQ0FBQyxpQkFBaUIsQ0FBQyxjQUFjLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFFM0YsNkdBQTZHO1lBQzdHLHNFQUFzRTtZQUN0RSxJQUFVLG1CQUFvQixDQUFDLEtBQUssRUFBRTtnQkFDbEMsTUFBWSxtQkFBb0IsQ0FBQyxLQUFLLENBQUM7YUFDMUM7WUFDRCxhQUFhLEdBQUcsbUJBQW1CLENBQUMsT0FBTyxDQUFDO1lBRTVDLG9HQUFvRztZQUNwRywyREFBMkQ7WUFDM0QsdURBQXVEO1lBQ3ZELEVBQUU7WUFDRiwrRkFBK0Y7WUFDL0YsSUFBSSxNQUFNLENBQUMsMkJBQTJCLEtBQUssSUFBSSxJQUFJLE1BQU0sQ0FBQywyQkFBMkIsS0FBSyxTQUFTLEVBQUU7Z0JBQ2pHLElBQUksYUFBYSxDQUFDLEtBQUssSUFBSSxhQUFhLENBQUMsS0FBSyxZQUFZLEdBQUcsRUFBRTtvQkFDM0QsYUFBYSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsb0JBQW9CLENBQUMsQ0FBQztpQkFDcEQ7Z0JBQ0QsSUFBSSxhQUFhLENBQUMsT0FBTyxJQUFJLGFBQWEsQ0FBQyxPQUFPLFlBQVksR0FBRyxFQUFFO29CQUMvRCxhQUFhLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO2lCQUN0RDthQUNKO1lBRUQsY0FBYyxHQUFHLG1CQUFtQixDQUFDLElBQUksQ0FBQztZQUUxQyxXQUFXLEdBQUc7Z0JBQ1YsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLGVBQWUsRUFBRSxlQUFlO2dCQUNoQyxhQUFhLEVBQUUsYUFBYTtnQkFDNUIsY0FBYyxFQUFFLGNBQWM7YUFDakMsQ0FBQztZQUNGLE9BQU8sV0FBVyxDQUFDLGFBQWEsQ0FBQztRQUNyQyxDQUFDO1FBRUQseUJBQXlCLE9BQWE7WUFDbEMsZ0VBQWdFO1lBQ2hFLElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsWUFBWSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQ25FLENBQUM7UUFFRCx3Q0FBd0MsSUFBd0I7WUFDNUQsT0FBTztnQkFDSCxPQUFPLEVBQUUsSUFBSSxDQUFDLElBQUk7Z0JBQ2xCLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFO2FBQ25ELENBQUM7UUFDTixDQUFDO1FBRUQseUJBQXlCLEdBQWU7WUFDcEMsSUFBSSxZQUFZLEdBQXlCLElBQUksQ0FBQztZQUM5QyxvRUFBb0U7WUFDcEUsSUFBVSxHQUFJLENBQUMsWUFBWSxFQUFFO2dCQUN6QixVQUFVO2dCQUNWLFlBQVksR0FBUyxHQUFJLENBQUMsWUFBWSxDQUFDO2FBQzFDO2lCQUFNO2dCQUNILHVFQUF1RTtnQkFDdkUsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUU7b0JBQ3JCLFlBQVksR0FBRyxDQUFNLEdBQUcsQ0FBQyxDQUFDO2lCQUM3QjtxQkFBTTtvQkFDSCxZQUFZLEdBQUcsR0FBRyxDQUFDO2lCQUN0QjthQUNKO1lBQ0QsT0FBTyxZQUFZLENBQUM7UUFDeEIsQ0FBQztRQUVELGlDQUFpQyxPQUEyQixFQUFFLFFBQWdCO1lBQzFFLElBQUksR0FBRyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUMzQixJQUFJLFlBQVksR0FBeUIsZUFBZSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBRTlELE9BQU87Z0JBQ0gsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLFdBQVcsRUFBRSxZQUFZLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsOEJBQThCLENBQUMsSUFBSSxDQUFDLENBQUM7YUFDOUUsQ0FBQTtRQUNMLENBQUM7UUFFRCwyQkFBMkIsS0FBNkIsRUFBRSxPQUEyQixFQUFFLFFBQWdCO1lBQ25HLEtBQUssQ0FBQyxJQUFJLENBQUM7Z0JBQ1AsV0FBVyxFQUFFLFFBQVEsT0FBTyxDQUFDLFdBQVcsRUFBRSxHQUFHO2dCQUM3QyxPQUFPLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUM7YUFDeEQsQ0FBQyxDQUFDO1FBQ1AsQ0FBQztRQUVELG1FQUFtRTtRQUNuRSw4QkFBOEIsS0FBNkIsRUFBRSxRQUFnQixFQUFFLFFBQXlDLEVBQUUsUUFBZ0I7WUFDdEksTUFBTSxPQUFPLEdBQWdDLEVBQUUsQ0FBQztZQUVoRCxLQUFLLE1BQU0sT0FBTyxJQUFJLFFBQVEsQ0FBQyxNQUFNLEVBQUUsRUFBRTtnQkFDckMsSUFBSSxPQUFPLENBQUMsV0FBVyxFQUFFLEtBQUssUUFBUSxFQUFFO29CQUNwQyxPQUFPLENBQUMsSUFBSSxDQUFDLHVCQUF1QixDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO2lCQUM1RDthQUNKO1lBRUQsNERBQTREO1lBQzVELElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7Z0JBQ3BCLE9BQU87YUFDVjtZQUVELEtBQUssQ0FBQyxJQUFJLENBQUM7Z0JBQ1AsV0FBVyxFQUFFLFlBQVksUUFBUSxHQUFHO2dCQUNwQyxPQUFPLEVBQUUsT0FBTzthQUNuQixDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsMkJBQTJCLEtBQTZCLEVBQUUsT0FBMkIsRUFBRSxRQUFnQixFQUFFLElBQTBCO1lBQy9ILEtBQUssQ0FBQyxJQUFJLENBQUM7Z0JBQ1AsV0FBVyxFQUFFLGlCQUFpQixPQUFPLENBQUMsV0FBVyxFQUFFLEdBQUc7Z0JBQ3RELE9BQU8sRUFBRSxDQUFDO3dCQUNOLFFBQVEsRUFBRSxRQUFRO3dCQUNsQixXQUFXLEVBQUUsQ0FBQztnQ0FDVixPQUFPLEVBQUUsK0JBQStCLE9BQU8sQ0FBQyxXQUFXLEVBQUUsSUFBSTtnQ0FDakUsSUFBSSxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQyxPQUFPLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUU7NkJBQzFHLENBQUM7cUJBQ0wsQ0FBQzthQUNMLENBQUMsQ0FBQztRQUNQLENBQUM7UUFFRCxpQ0FBaUMsS0FBNkI7WUFDMUQsbUdBQW1HO1lBQ25HLElBQUksb0JBQW9CLEdBQUcsS0FBSyxDQUFDO1lBQ2pDLElBQUksb0JBQW9CLElBQUksV0FBVyxJQUFJLFdBQVcsQ0FBQyxjQUFjLEVBQUU7Z0JBQ25FLEtBQUssQ0FBQyxJQUFJLENBQUM7b0JBQ1AsV0FBVyxFQUFFLGtCQUFrQjtvQkFDL0IsT0FBTyxFQUFFLENBQUM7NEJBQ04sUUFBUSxFQUFFLFdBQVcsQ0FBQyxjQUFjOzRCQUNwQyxXQUFXLEVBQUUsRUFBRTt5QkFDbEIsQ0FBQztpQkFDTCxDQUFDLENBQUM7YUFDTjtRQUNMLENBQUM7UUFFRCwyQkFBMkIsS0FBNkIsRUFBRSxhQUE4QyxFQUFFLFFBQWdCO1lBQ3RILE1BQU0sZUFBZSxHQUFHLDZCQUE2QixDQUFDLGFBQWEsQ0FBQyxDQUFDO1lBQ3JFLEtBQUssQ0FBQyxJQUFJLENBQUM7Z0JBQ1AsV0FBVyxFQUFFLHNDQUFzQztnQkFDbkQsT0FBTyxFQUFFLENBQUM7d0JBQ04sUUFBUSxFQUFFLFFBQVE7d0JBQ2xCLFdBQVcsRUFBRSxlQUFlLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsOEJBQThCLENBQUMsSUFBSSxDQUFDLENBQUM7cUJBQ2pGLENBQUM7YUFDTCxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsd0JBQXdCLE9BQTJCLEVBQUUsRUFBUztZQUMxRCxPQUFPLGVBQWUsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNqRCxDQUFDO1FBRUQsc0JBQXNCLFFBQThCO1lBQ25ELHFHQUFxRztZQUNsRyxPQUFPLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUU7Z0JBQzFCLE9BQU8sY0FBYyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLEdBQUcsY0FBYyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7WUFDbkUsQ0FBQyxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsdUNBQXVDLGFBQThDO1lBQ2pGLGtCQUFrQixDQUFxQixFQUFFLENBQXFCO2dCQUMxRCxPQUFPLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQztZQUM1QixDQUFDO1lBRUQsSUFBSSxjQUFjLEdBQUcsWUFBWSxDQUFDLENBQUMsR0FBRyxhQUFhLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQy9ELElBQUksY0FBYyxHQUF5QixFQUFFLENBQUM7WUFDOUMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLGNBQWMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7Z0JBQzVDLElBQUksWUFBWSxHQUFHLGVBQWUsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztnQkFDL0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxjQUFjLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO29CQUNsRixjQUFjLENBQUMsSUFBSSxDQUFDLEdBQUcsWUFBWSxDQUFDLENBQUE7aUJBQ3ZDO2FBQ0o7WUFDRCxPQUFPLGNBQWMsQ0FBQztRQUMxQixDQUFDO1FBRUQsS0FBSyxDQUFDLHNCQUFzQixHQUFHLENBQUMsUUFBZ0IsRUFBRSxFQUFFO1lBQ2hELE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUVyRCxJQUFJLE1BQU0sQ0FBQyw2QkFBNkIsSUFBSSxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtnQkFDMUQsT0FBTyxLQUFLLENBQUM7YUFDaEI7WUFFRCxJQUFJO2dCQUNBLElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsMENBQTBDLENBQUMsQ0FBQztnQkFDcEYsSUFBSSxjQUFjLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxFQUFFO29CQUM5QixjQUFjLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDO2lCQUNuQztnQkFFRCxJQUFJLE1BQU0sQ0FBQyxxQkFBcUIsS0FBSyxJQUFJLElBQUksUUFBUSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRTtvQkFDckUsT0FBTyxLQUFLLENBQUM7aUJBQ2hCO2dCQUVELElBQUk7b0JBQ0EsYUFBYSxHQUFHLGdCQUFnQixDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUM7b0JBQzlELElBQUksYUFBYSxDQUFDLGFBQWE7d0JBQzNCLGFBQWEsQ0FBQyxhQUFhLENBQUMsT0FBTzt3QkFDbkMsYUFBYSxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLFVBQVUsT0FBTyxJQUFJLE9BQU8sSUFBSSxTQUFTLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQSxDQUFDLENBQUMsQ0FBQyxFQUFFO3dCQUMxSCxPQUFPLEtBQUssQ0FBQztxQkFDaEI7aUJBQ0o7Z0JBQUMsT0FBTyxHQUFHLEVBQUU7b0JBQ1YsMEZBQTBGO29CQUMxRix1REFBdUQ7b0JBQ3ZELElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsOEJBQThCLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQTtvQkFDNUUsT0FBTyxLQUFLLENBQUM7aUJBQ2hCO2dCQUVELElBQUksTUFBeUIsQ0FBQztnQkFFOUIsc0RBQXNEO2dCQUN0RCwrREFBK0Q7Z0JBQy9ELElBQUksSUFBSSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUM7Z0JBQ3hCLE9BQU8sQ0FBQyxJQUFJLEdBQUcsZUFBZSxDQUFDO2dCQUUvQixJQUFJLEVBQUUsaUNBQWlDO29CQUNuQyxtSEFBbUg7b0JBQ25ILHdCQUF3QjtvQkFDeEIsSUFBSSxPQUFPLEdBQTBCLEVBQUUsR0FBRyxFQUFFLEtBQUssRUFBRSxDQUFDO29CQUNwRCxJQUFJLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFPLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDO29CQUNqRSxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxFQUFFLEVBQUUsYUFBYSxDQUFDLENBQUM7b0JBQ3pDLE1BQU0sR0FBRyxNQUFNLENBQUMsU0FBUyxFQUFFLENBQUM7aUJBQy9CO2dCQUFDLE9BQU8sR0FBRyxFQUFFO29CQUNWLElBQUksWUFBWSxHQUFHLGVBQWUsQ0FBQztvQkFDbkMsSUFBSSxPQUFPLEdBQUcsQ0FBQyxPQUFPLEtBQUssUUFBUSxJQUFJLEdBQUcsQ0FBQyxPQUFPLFlBQVksTUFBTSxFQUFFO3dCQUNsRSxZQUFZLEdBQVcsR0FBRyxDQUFDLE9BQU8sQ0FBQztxQkFDdEM7b0JBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLEdBQUcsWUFBWSxDQUFDLENBQUM7b0JBQ3hFLE9BQU8sS0FBSyxDQUFDO2lCQUNoQjt3QkFBUztvQkFDTixPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztpQkFDdkI7Z0JBRUQsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7b0JBQzVCLE1BQU0sY0FBYyxHQUFHLHlCQUF5QixDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7b0JBQzVFLElBQUksY0FBYyxJQUFJLGNBQWMsQ0FBQyxNQUFNLEVBQUU7d0JBQ3pDLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLENBQUM7d0JBQ3hELE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7d0JBQzVDLGNBQWMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUU7NEJBQzdCLFdBQVcsQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDOzRCQUNoRCxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUM7d0JBQ3BDLENBQUMsQ0FBQyxDQUFDO3dCQUNILE9BQU8sV0FBVyxDQUFDO3FCQUN0QjtpQkFDSjthQUNKO1lBQUMsT0FBTyxDQUFDLEVBQUU7Z0JBQ1IsSUFBSSxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxrQ0FBa0MsQ0FBQyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUMsQ0FBQztnQkFDMUYsSUFBSSxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUM7YUFDdEU7WUFDRCxPQUFPLEtBQUssQ0FBQztRQUNqQixDQUFDLENBQUM7UUFFRixLQUFLLENBQUMsc0JBQXNCLEdBQUcsVUFBVSxRQUFnQixFQUFFLEtBQWEsRUFBRSxHQUFXLEVBQUUsVUFBb0IsRUFBRSxhQUFvQyxFQUFFLFdBQStCO1lBQzlLLElBQUksS0FBSyxHQUFHLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxRQUFRLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRSxVQUFVLEVBQUUsYUFBYSxFQUFFLFdBQVcsQ0FBQyxDQUFDO1lBQ3ZHLElBQUksTUFBTSxDQUFDLDZCQUE2QixJQUFJLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO2dCQUMxRCxPQUFPLEtBQUssQ0FBQzthQUNoQjtZQUVELElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsdUNBQXVDLEdBQUcsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDakcsSUFBSSxhQUFhLEdBQUcsY0FBYyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUVqRCxJQUFJLGFBQWEsRUFBRTtnQkFDZixNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUV0QyxJQUFJLE9BQU8sR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQztnQkFDeEQsSUFBSSxPQUFPLEVBQUU7b0JBQ1QsaUJBQWlCLENBQUMsS0FBSyxFQUFFLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQztvQkFDNUMsb0JBQW9CLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxXQUFXLEVBQUUsRUFBRSxhQUFhLEVBQUUsUUFBUSxDQUFDLENBQUM7aUJBQy9FO2dCQUNELGlCQUFpQixDQUFDLEtBQUssRUFBRSxhQUFhLEVBQUUsUUFBUSxDQUFDLENBQUM7Z0JBQ2xELElBQUksT0FBTyxFQUFFO29CQUNULHVCQUF1QixDQUFDLEtBQUssQ0FBQyxDQUFDO29CQUMvQixpQkFBaUIsQ0FBQyxLQUFLLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7aUJBQzNGO2dCQUVELE9BQU8sS0FBSyxDQUFDO2FBQ2hCO1lBRUQsT0FBTyxLQUFLLENBQUM7UUFDakIsQ0FBQyxDQUFDO1FBQ0YsT0FBTyxLQUFLLENBQUM7SUFDakIsQ0FBQztJQUVELE9BQU8sRUFBRSxNQUFNLEVBQUUsQ0FBQztBQUN0QixDQUFDO0FBRUQsaUJBQVMsSUFBSSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgdHNfbW9kdWxlIGZyb20gXCIuLi9ub2RlX21vZHVsZXMvdHlwZXNjcmlwdC9saWIvdHNzZXJ2ZXJsaWJyYXJ5XCI7XG5pbXBvcnQgKiBhcyB0c2xpbnQgZnJvbSAndHNsaW50JztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBtb2NrUmVxdWlyZSBmcm9tICdtb2NrLXJlcXVpcmUnO1xuaW1wb3J0ICogYXMgbWluaW1hdGNoIGZyb20gJ21pbmltYXRjaCc7XG5cbi8vIFNldHRpbmdzIGZvciB0aGUgcGx1Z2luIHNlY3Rpb24gaW4gdHNjb25maWcuanNvblxuaW50ZXJmYWNlIFNldHRpbmdzIHtcbiAgICBhbHdheXNTaG93UnVsZUZhaWx1cmVzQXNXYXJuaW5ncz86IGJvb2xlYW47XG4gICAgaWdub3JlRGVmaW5pdGlvbkZpbGVzPzogYm9vbGVhbjtcbiAgICBjb25maWdGaWxlPzogc3RyaW5nO1xuICAgIGRpc2FibGVOb1VudXNlZFZhcmlhYmxlUnVsZT86IGJvb2xlYW4gIC8vIHN1cHBvcnQgdG8gZW5hYmxlL2Rpc2FibGUgdGhlIHdvcmthcm91bmQgZm9yIGh0dHBzOi8vZ2l0aHViLmNvbS9NaWNyb3NvZnQvVHlwZVNjcmlwdC9pc3N1ZXMvMTUzNDRcbiAgICBzdXByZXNzV2hpbGVUeXBlRXJyb3JzUHJlc2VudDogYm9vbGVhbjtcbiAgICBtb2NrVHlwZVNjcmlwdFZlcnNpb246IGJvb2xlYW47XG59XG5cbmNvbnN0IFRTTElOVF9FUlJPUl9DT0RFID0gMTAwMDAwO1xuXG5mdW5jdGlvbiBpbml0KG1vZHVsZXM6IHsgdHlwZXNjcmlwdDogdHlwZW9mIHRzX21vZHVsZSB9KSB7XG4gICAgY29uc3QgdHMgPSBtb2R1bGVzLnR5cGVzY3JpcHQ7XG5cbiAgICBsZXQgY29kZUZpeEFjdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgTWFwPHN0cmluZywgdHNsaW50LlJ1bGVGYWlsdXJlPj4oKTtcbiAgICBsZXQgcmVnaXN0ZXJlZENvZGVGaXhlcyA9IGZhbHNlO1xuXG4gICAgbGV0IGNvbmZpZ0NhY2hlID0ge1xuICAgICAgICBmaWxlUGF0aDogPHN0cmluZz5udWxsLFxuICAgICAgICBjb25maWd1cmF0aW9uOiA8YW55Pm51bGwsXG4gICAgICAgIGlzRGVmYXVsdENvbmZpZzogZmFsc2UsXG4gICAgICAgIGNvbmZpZ0ZpbGVQYXRoOiA8c3RyaW5nPm51bGxcbiAgICB9O1xuXG4gICAgLy8gV29yayBhcm91bmQgdGhlIGxhY2sgb2YgQVBJIHRvIHJlZ2lzdGVyIGEgQ29kZUZpeFxuICAgIGZ1bmN0aW9uIHJlZ2lzdGVyQ29kZUZpeChhY3Rpb246IGNvZGVmaXguQ29kZUZpeCkge1xuICAgICAgICByZXR1cm4gKHRzIGFzIGFueSkuY29kZWZpeC5yZWdpc3RlckNvZGVGaXgoYWN0aW9uKTtcbiAgICB9XG5cbiAgICBpZiAoIXJlZ2lzdGVyZWRDb2RlRml4ZXMgJiYgdHMgJiYgKHRzIGFzIGFueSkuY29kZWZpeCkge1xuICAgICAgICByZWdpc3RlckNvZGVGaXhlcyhyZWdpc3RlckNvZGVGaXgpO1xuICAgICAgICByZWdpc3RlcmVkQ29kZUZpeGVzID0gdHJ1ZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZWdpc3RlckNvZGVGaXhlcyhyZWdpc3RlckNvZGVGaXg6IChhY3Rpb246IGNvZGVmaXguQ29kZUZpeCkgPT4gdm9pZCkge1xuICAgICAgICAvLyBDb2RlIGZpeCBmb3IgdGhhdCBpcyB1c2VkIGZvciBhbGwgdHNsaW50IGZpeGVzXG4gICAgICAgIHJlZ2lzdGVyQ29kZUZpeCh7XG4gICAgICAgICAgICBlcnJvckNvZGVzOiBbVFNMSU5UX0VSUk9SX0NPREVdLFxuICAgICAgICAgICAgZ2V0Q29kZUFjdGlvbnM6IChfY29udGV4dDogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGZpeFJlbGF0aXZlQ29uZmlnRmlsZVBhdGgoY29uZmlnOiBTZXR0aW5ncywgcHJvamVjdFJvb3Q6IHN0cmluZyk6IFNldHRpbmdzIHtcbiAgICAgICAgaWYgKCFjb25maWcuY29uZmlnRmlsZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbmZpZztcbiAgICAgICAgfVxuICAgICAgICBpZiAocGF0aC5pc0Fic29sdXRlKGNvbmZpZy5jb25maWdGaWxlKSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbmZpZztcbiAgICAgICAgfVxuICAgICAgICBjb25maWcuY29uZmlnRmlsZSA9IHBhdGguam9pbihwcm9qZWN0Um9vdCwgY29uZmlnLmNvbmZpZ0ZpbGUpO1xuICAgICAgICByZXR1cm4gY29uZmlnO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNyZWF0ZShpbmZvOiB0cy5zZXJ2ZXIuUGx1Z2luQ3JlYXRlSW5mbykge1xuICAgICAgICBpbmZvLnByb2plY3QucHJvamVjdFNlcnZpY2UubG9nZ2VyLmluZm8oXCJ0c2xpbnQtbGFuZ3VhZ2Utc2VydmljZSBsb2FkZWRcIik7XG4gICAgICAgIGxldCBjb25maWc6IFNldHRpbmdzID0gZml4UmVsYXRpdmVDb25maWdGaWxlUGF0aChpbmZvLmNvbmZpZywgaW5mby5wcm9qZWN0LmdldEN1cnJlbnREaXJlY3RvcnkoKSk7XG4gICAgICAgIGxldCBjb25maWd1cmF0aW9uOiB0c2xpbnQuQ29uZmlndXJhdGlvbi5JQ29uZmlndXJhdGlvbkZpbGUgPSBudWxsO1xuXG4gICAgICAgIGlmKGNvbmZpZy5tb2NrVHlwZVNjcmlwdFZlcnNpb24pIHtcbiAgICAgICAgICAgIG1vY2tSZXF1aXJlKCd0eXBlc2NyaXB0JywgdHMpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHRzbGludCA9IHJlcXVpcmUoJ3RzbGludCcpXG5cbiAgICAgICAgLy8gU2V0IHVwIGRlY29yYXRvclxuICAgICAgICBjb25zdCBwcm94eSA9IE9iamVjdC5jcmVhdGUobnVsbCkgYXMgdHMuTGFuZ3VhZ2VTZXJ2aWNlO1xuICAgICAgICBjb25zdCBvbGRMUyA9IGluZm8ubGFuZ3VhZ2VTZXJ2aWNlO1xuICAgICAgICBmb3IgKGNvbnN0IGsgaW4gb2xkTFMpIHtcbiAgICAgICAgICAgICg8YW55PnByb3h5KVtrXSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gKDxhbnk+b2xkTFMpW2tdLmFwcGx5KG9sZExTLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8ga2V5IHRvIGlkZW50aWZ5IGEgcnVsZSBmYWlsdXJlXG4gICAgICAgIGZ1bmN0aW9uIGNvbXB1dGVLZXkoc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIpOiBzdHJpbmcge1xuICAgICAgICAgICAgcmV0dXJuIGBbJHtzdGFydH0sJHtlbmR9XWA7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBtYWtlRGlhZ25vc3RpYyhwcm9ibGVtOiB0c2xpbnQuUnVsZUZhaWx1cmUsIGZpbGU6IHRzLlNvdXJjZUZpbGUpOiB0cy5EaWFnbm9zdGljIHtcbiAgICAgICAgICAgIGxldCBtZXNzYWdlID0gKHByb2JsZW0uZ2V0UnVsZU5hbWUoKSAhPT0gbnVsbClcbiAgICAgICAgICAgICAgICA/IGAke3Byb2JsZW0uZ2V0RmFpbHVyZSgpfSAoJHtwcm9ibGVtLmdldFJ1bGVOYW1lKCl9KWBcbiAgICAgICAgICAgICAgICA6IGAke3Byb2JsZW0uZ2V0RmFpbHVyZSgpfWA7XG5cbiAgICAgICAgICAgIGxldCBjYXRlZ29yeTtcbiAgICAgICAgICAgIGlmIChjb25maWcuYWx3YXlzU2hvd1J1bGVGYWlsdXJlc0FzV2FybmluZ3MgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBjYXRlZ29yeSA9IHRzLkRpYWdub3N0aWNDYXRlZ29yeS5XYXJuaW5nO1xuICAgICAgICAgICAgfSBlbHNlIGlmICgoPGFueT5wcm9ibGVtKS5nZXRSdWxlU2V2ZXJpdHkgJiYgKDxhbnk+cHJvYmxlbSkuZ2V0UnVsZVNldmVyaXR5KCkgPT09ICdlcnJvcicpIHtcbiAgICAgICAgICAgICAgICAvLyB0c2xpbnQ1IHN1cHBvcnRzIHRvIGFzc2lnbiBzZXZlcml0aWVzIHRvIHJ1bGVzXG4gICAgICAgICAgICAgICAgY2F0ZWdvcnkgPSB0cy5EaWFnbm9zdGljQ2F0ZWdvcnkuRXJyb3I7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNhdGVnb3J5ID0gdHMuRGlhZ25vc3RpY0NhdGVnb3J5Lldhcm5pbmc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBkaWFnbm9zdGljOiB0cy5EaWFnbm9zdGljID0ge1xuICAgICAgICAgICAgICAgIGZpbGU6IGZpbGUsXG4gICAgICAgICAgICAgICAgc3RhcnQ6IHByb2JsZW0uZ2V0U3RhcnRQb3NpdGlvbigpLmdldFBvc2l0aW9uKCksXG4gICAgICAgICAgICAgICAgbGVuZ3RoOiBwcm9ibGVtLmdldEVuZFBvc2l0aW9uKCkuZ2V0UG9zaXRpb24oKSAtIHByb2JsZW0uZ2V0U3RhcnRQb3NpdGlvbigpLmdldFBvc2l0aW9uKCksXG4gICAgICAgICAgICAgICAgbWVzc2FnZVRleHQ6IG1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgY2F0ZWdvcnk6IGNhdGVnb3J5LFxuICAgICAgICAgICAgICAgIHNvdXJjZTogJ3RzbGludCcsXG4gICAgICAgICAgICAgICAgY29kZTogVFNMSU5UX0VSUk9SX0NPREVcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICByZXR1cm4gZGlhZ25vc3RpYztcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBGaWx0ZXIgZmFpbHVyZXMgZm9yIHRoZSBnaXZlbiBkb2N1bWVudFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gZmlsdGVyUHJvYmxlbXNGb3JEb2N1bWVudChkb2N1bWVudFBhdGg6IHN0cmluZywgZmFpbHVyZXM6IHRzbGludC5SdWxlRmFpbHVyZVtdKTogdHNsaW50LlJ1bGVGYWlsdXJlW10ge1xuICAgICAgICAgICAgbGV0IG5vcm1hbGl6ZWRQYXRoID0gcGF0aC5ub3JtYWxpemUoZG9jdW1lbnRQYXRoKTtcbiAgICAgICAgICAgIC8vIHdlIG9ubHkgc2hvdyBkaWFnbm9zdGljcyB0YXJnZXR0aW5nIHRoaXMgb3BlbiBkb2N1bWVudCwgc29tZSB0c2xpbnQgcnVsZSByZXR1cm4gZGlhZ25vc3RpY3MgZm9yIG90aGVyIGRvY3VtZW50cy9maWxlc1xuICAgICAgICAgICAgbGV0IG5vcm1hbGl6ZWRGaWxlcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgICAgICAgICByZXR1cm4gZmFpbHVyZXMuZmlsdGVyKGVhY2ggPT4ge1xuICAgICAgICAgICAgICAgIGxldCBmaWxlTmFtZSA9IGVhY2guZ2V0RmlsZU5hbWUoKTtcbiAgICAgICAgICAgICAgICBpZiAoIW5vcm1hbGl6ZWRGaWxlcy5oYXMoZmlsZU5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRGaWxlcy5zZXQoZmlsZU5hbWUsIHBhdGgubm9ybWFsaXplKGZpbGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBub3JtYWxpemVkRmlsZXMuZ2V0KGZpbGVOYW1lKSA9PT0gbm9ybWFsaXplZFBhdGg7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlcGxhY2VtZW50c0FyZUVtcHR5KGZpeDogdHNsaW50LkZpeCk6IGJvb2xlYW4ge1xuICAgICAgICAgICAgLy8gaW4gdHNsaW50IDQgYSBGaXggaGFzIGEgcmVwbGFjZW1lbnQgcHJvcGVydHkgd2l0aHQgdGhlIFJlcGxhY2VtZW50c1xuICAgICAgICAgICAgaWYgKCg8YW55PmZpeCkucmVwbGFjZW1lbnRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICg8YW55PmZpeCkucmVwbGFjZW1lbnRzLmxlbmd0aCA9PT0gMDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIHRzbGludCA1XG4gICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmaXgpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZpeC5sZW5ndGggPT09IDA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWNvcmRDb2RlQWN0aW9uKHByb2JsZW06IHRzbGludC5SdWxlRmFpbHVyZSwgZmlsZTogdHMuU291cmNlRmlsZSkge1xuICAgICAgICAgICAgbGV0IGZpeDogdHNsaW50LkZpeCA9IG51bGw7XG5cbiAgICAgICAgICAgIC8vIHRzbGludCBjYW4gcmV0dXJuIGEgZml4IHdpdGggYW4gZW1wdHkgcmVwbGFjZW1lbnRzIGFycmF5LCB0aGVzZSBmaXhlcyBhcmUgaWdub3JlZFxuICAgICAgICAgICAgaWYgKHByb2JsZW0uZ2V0Rml4ICYmIHByb2JsZW0uZ2V0Rml4KCkgJiYgIXJlcGxhY2VtZW50c0FyZUVtcHR5KHByb2JsZW0uZ2V0Rml4KCkpKSB7IC8vIHRzbGludCBmaXhlcyBhcmUgbm90IGF2YWlsYWJsZSBpbiB0c2xpbnQgPCAzLjE3XG4gICAgICAgICAgICAgICAgZml4ID0gcHJvYmxlbS5nZXRGaXgoKTsgLy8gY3JlYXRlQXV0b0ZpeChwcm9ibGVtLCBkb2N1bWVudCwgcHJvYmxlbS5nZXRGaXgoKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghZml4KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZG9jdW1lbnRBdXRvRml4ZXM6IE1hcDxzdHJpbmcsIHRzbGludC5SdWxlRmFpbHVyZT4gPSBjb2RlRml4QWN0aW9ucy5nZXQoZmlsZS5maWxlTmFtZSk7XG4gICAgICAgICAgICBpZiAoIWRvY3VtZW50QXV0b0ZpeGVzKSB7XG4gICAgICAgICAgICAgICAgZG9jdW1lbnRBdXRvRml4ZXMgPSBuZXcgTWFwPHN0cmluZywgdHNsaW50LlJ1bGVGYWlsdXJlPigpO1xuICAgICAgICAgICAgICAgIGNvZGVGaXhBY3Rpb25zLnNldChmaWxlLmZpbGVOYW1lLCBkb2N1bWVudEF1dG9GaXhlcyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkb2N1bWVudEF1dG9GaXhlcy5zZXQoY29tcHV0ZUtleShwcm9ibGVtLmdldFN0YXJ0UG9zaXRpb24oKS5nZXRQb3NpdGlvbigpLCBwcm9ibGVtLmdldEVuZFBvc2l0aW9uKCkuZ2V0UG9zaXRpb24oKSksIHByb2JsZW0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0Q29uZmlndXJhdGlvbkZhaWx1cmVNZXNzYWdlKGVycjogYW55KTogc3RyaW5nIHtcbiAgICAgICAgICAgIGxldCBlcnJvck1lc3NhZ2UgPSBgdW5rbm93biBlcnJvcmA7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGVyci5tZXNzYWdlID09PSAnc3RyaW5nJyB8fCBlcnIubWVzc2FnZSBpbnN0YW5jZW9mIFN0cmluZykge1xuICAgICAgICAgICAgICAgIGVycm9yTWVzc2FnZSA9IDxzdHJpbmc+ZXJyLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gYHRzbGludDogQ2Fubm90IHJlYWQgdHNsaW50IGNvbmZpZ3VyYXRpb24gLSAnJHtlcnJvck1lc3NhZ2V9J2A7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRDb25maWd1cmF0aW9uKGZpbGVQYXRoOiBzdHJpbmcsIGNvbmZpZ0ZpbGVOYW1lOiBzdHJpbmcpOiBhbnkge1xuICAgICAgICAgICAgaWYgKGNvbmZpZ0NhY2hlLmNvbmZpZ3VyYXRpb24gJiYgY29uZmlnQ2FjaGUuZmlsZVBhdGggPT09IGZpbGVQYXRoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbmZpZ0NhY2hlLmNvbmZpZ3VyYXRpb247XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBpc0RlZmF1bHRDb25maWcgPSBmYWxzZTtcbiAgICAgICAgICAgIGxldCBjb25maWd1cmF0aW9uO1xuICAgICAgICAgICAgbGV0IGNvbmZpZ0ZpbGVQYXRoID0gbnVsbDtcblxuICAgICAgICAgICAgaXNEZWZhdWx0Q29uZmlnID0gdHNsaW50LkNvbmZpZ3VyYXRpb24uZmluZENvbmZpZ3VyYXRpb25QYXRoKGNvbmZpZ0ZpbGVOYW1lLCBmaWxlUGF0aCkgPT09IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIGxldCBjb25maWd1cmF0aW9uUmVzdWx0ID0gdHNsaW50LkNvbmZpZ3VyYXRpb24uZmluZENvbmZpZ3VyYXRpb24oY29uZmlnRmlsZU5hbWUsIGZpbGVQYXRoKTtcblxuICAgICAgICAgICAgLy8gYmV0d2VlbiB0c2xpbnQgNC4wLjEgYW5kIHRzbGludCA0LjAuMiB0aGUgYXR0cmlidXRlICdlcnJvcicgaGFzIGJlZW4gcmVtb3ZlZCBmcm9tIElDb25maWd1cmF0aW9uTG9hZFJlc3VsdFxuICAgICAgICAgICAgLy8gaW4gNC4wLjIgZmluZENvbmZpZ3VyYXRpb24gdGhyb3dzIGFuIGV4Y2VwdGlvbiBhcyBpbiB2ZXJzaW9uIF4zLjAuMFxuICAgICAgICAgICAgaWYgKCg8YW55PmNvbmZpZ3VyYXRpb25SZXN1bHQpLmVycm9yKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgKDxhbnk+Y29uZmlndXJhdGlvblJlc3VsdCkuZXJyb3I7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25maWd1cmF0aW9uID0gY29uZmlndXJhdGlvblJlc3VsdC5yZXN1bHRzO1xuXG4gICAgICAgICAgICAvLyBJbiB0c2xpbnQgdmVyc2lvbiA1IHRoZSAnbm8tdW51c2VkLXZhcmlhYmxlJyBydWxlcyBicmVha3MgdGhlIFR5cGVTY3JpcHQgbGFuZ3VhZ2Ugc2VydmljZSBwbHVnaW4uXG4gICAgICAgICAgICAvLyBTZWUgaHR0cHM6Ly9naXRodWIuY29tL01pY3Jvc29mdC9UeXBlU2NyaXB0L2lzc3Vlcy8xNTM0NFxuICAgICAgICAgICAgLy8gVGhlcmVmb3JlIHdlIHJlbW92ZSB0aGUgcnVsZSBmcm9tIHRoZSBjb25maWd1cmF0aW9uLlxuICAgICAgICAgICAgLy9cbiAgICAgICAgICAgIC8vIEluIHRzbGludCA1IHRoZSBydWxlcyBhcmUgc3RvcmVkIGluIGEgTWFwLCBpbiBlYXJsaWVyIHZlcnNpb25zIHRoZXkgd2VyZSBzdG9yZWQgaW4gYW4gT2JqZWN0XG4gICAgICAgICAgICBpZiAoY29uZmlnLmRpc2FibGVOb1VudXNlZFZhcmlhYmxlUnVsZSA9PT0gdHJ1ZSB8fCBjb25maWcuZGlzYWJsZU5vVW51c2VkVmFyaWFibGVSdWxlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29uZmlndXJhdGlvbi5ydWxlcyAmJiBjb25maWd1cmF0aW9uLnJ1bGVzIGluc3RhbmNlb2YgTWFwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyYXRpb24ucnVsZXMuZGVsZXRlKCduby11bnVzZWQtdmFyaWFibGUnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGNvbmZpZ3VyYXRpb24uanNSdWxlcyAmJiBjb25maWd1cmF0aW9uLmpzUnVsZXMgaW5zdGFuY2VvZiBNYXApIHtcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJhdGlvbi5qc1J1bGVzLmRlbGV0ZSgnbm8tdW51c2VkLXZhcmlhYmxlJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25maWdGaWxlUGF0aCA9IGNvbmZpZ3VyYXRpb25SZXN1bHQucGF0aDtcblxuICAgICAgICAgICAgY29uZmlnQ2FjaGUgPSB7XG4gICAgICAgICAgICAgICAgZmlsZVBhdGg6IGZpbGVQYXRoLFxuICAgICAgICAgICAgICAgIGlzRGVmYXVsdENvbmZpZzogaXNEZWZhdWx0Q29uZmlnLFxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyYXRpb246IGNvbmZpZ3VyYXRpb24sXG4gICAgICAgICAgICAgICAgY29uZmlnRmlsZVBhdGg6IGNvbmZpZ0ZpbGVQYXRoXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgcmV0dXJuIGNvbmZpZ0NhY2hlLmNvbmZpZ3VyYXRpb247XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGZ1bmN0aW9uIGNhcHR1cmVXYXJuaW5ncyhtZXNzYWdlPzogYW55KTogdm9pZCB7XG4gICAgICAgICAgICAvLyBUT0RPIGxvZyB0byBhIHVzZXIgdmlzaWJsZSBsb2cgYW5kIG5vdCBvbmx5IHRoZSBUUy1TZXJ2ZXIgbG9nXG4gICAgICAgICAgICBpbmZvLnByb2plY3QucHJvamVjdFNlcnZpY2UubG9nZ2VyLmluZm8oYFt0c2xpbnRdICR7bWVzc2FnZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGNvbnZlcnRSZXBsYWNlbWVudFRvVGV4dENoYW5nZShyZXBsOiB0c2xpbnQuUmVwbGFjZW1lbnQpOiB0cy5UZXh0Q2hhbmdlIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgbmV3VGV4dDogcmVwbC50ZXh0LFxuICAgICAgICAgICAgICAgIHNwYW46IHsgc3RhcnQ6IHJlcGwuc3RhcnQsIGxlbmd0aDogcmVwbC5sZW5ndGggfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgZnVuY3Rpb24gZ2V0UmVwbGFjZW1lbnRzKGZpeDogdHNsaW50LkZpeCk6IHRzbGludC5SZXBsYWNlbWVudFtde1xuICAgICAgICAgICAgbGV0IHJlcGxhY2VtZW50czogdHNsaW50LlJlcGxhY2VtZW50W10gPSBudWxsO1xuICAgICAgICAgICAgLy8gaW4gdHNsaW50NCBhIEZpeCBoYXMgYSByZXBsYWNlbWVudCBwcm9wZXJ0eSB3aXRoIHRoZSBSZXBsYWNlbWVudHNcbiAgICAgICAgICAgIGlmICgoPGFueT5maXgpLnJlcGxhY2VtZW50cykge1xuICAgICAgICAgICAgICAgIC8vIHRzbGludDRcbiAgICAgICAgICAgICAgICByZXBsYWNlbWVudHMgPSAoPGFueT5maXgpLnJlcGxhY2VtZW50cztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gaW4gdHNsaW50IDUgYSBGaXggaXMgYSBSZXBsYWNlbWVudCB8IFJlcGxhY2VtZW50W10gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZml4KSkge1xuICAgICAgICAgICAgICAgICAgICByZXBsYWNlbWVudHMgPSBbPGFueT5maXhdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlcGxhY2VtZW50cyA9IGZpeDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVwbGFjZW1lbnRzO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcHJvYmxlbVRvRmlsZVRleHRDaGFuZ2UocHJvYmxlbTogdHNsaW50LlJ1bGVGYWlsdXJlLCBmaWxlTmFtZTogc3RyaW5nKTogdHNfbW9kdWxlLkZpbGVUZXh0Q2hhbmdlcyB7XG4gICAgICAgICAgICBsZXQgZml4ID0gcHJvYmxlbS5nZXRGaXgoKTtcbiAgICAgICAgICAgIGxldCByZXBsYWNlbWVudHM6IHRzbGludC5SZXBsYWNlbWVudFtdID0gZ2V0UmVwbGFjZW1lbnRzKGZpeCk7XG5cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgZmlsZU5hbWU6IGZpbGVOYW1lLFxuICAgICAgICAgICAgICAgIHRleHRDaGFuZ2VzOiByZXBsYWNlbWVudHMubWFwKGVhY2ggPT4gY29udmVydFJlcGxhY2VtZW50VG9UZXh0Q2hhbmdlKGVhY2gpKSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGFkZFJ1bGVGYWlsdXJlRml4KGZpeGVzOiB0c19tb2R1bGUuQ29kZUFjdGlvbltdLCBwcm9ibGVtOiB0c2xpbnQuUnVsZUZhaWx1cmUsIGZpbGVOYW1lOiBzdHJpbmcpIHtcbiAgICAgICAgICAgIGZpeGVzLnB1c2goe1xuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBgRml4ICcke3Byb2JsZW0uZ2V0UnVsZU5hbWUoKX0nYCxcbiAgICAgICAgICAgICAgICBjaGFuZ2VzOiBbcHJvYmxlbVRvRmlsZVRleHRDaGFuZ2UocHJvYmxlbSwgZmlsZU5hbWUpXVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKiBHZW5lcmF0ZSBhIGNvZGUgYWN0aW9uIHRoYXQgZml4ZXMgYWxsIGluc3RhbmNlcyBvZiBydWxlTmFtZS4gICovXG4gICAgICAgIGZ1bmN0aW9uIGFkZFJ1bGVGYWlsdXJlRml4QWxsKGZpeGVzOiB0c19tb2R1bGUuQ29kZUFjdGlvbltdLCBydWxlTmFtZTogc3RyaW5nLCBwcm9ibGVtczogTWFwPHN0cmluZywgdHNsaW50LlJ1bGVGYWlsdXJlPiwgZmlsZU5hbWU6IHN0cmluZykge1xuICAgICAgICAgICAgY29uc3QgY2hhbmdlczogdHNfbW9kdWxlLkZpbGVUZXh0Q2hhbmdlc1tdID0gW107XG5cbiAgICAgICAgICAgIGZvciAoY29uc3QgcHJvYmxlbSBvZiBwcm9ibGVtcy52YWx1ZXMoKSkge1xuICAgICAgICAgICAgICAgIGlmIChwcm9ibGVtLmdldFJ1bGVOYW1lKCkgPT09IHJ1bGVOYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgIGNoYW5nZXMucHVzaChwcm9ibGVtVG9GaWxlVGV4dENoYW5nZShwcm9ibGVtLCBmaWxlTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyogTm8gbmVlZCBmb3IgdGhpcyBhY3Rpb24gaWYgdGhlcmUncyBvbmx5IG9uZSBpbnN0YW5jZS4gICovXG4gICAgICAgICAgICBpZiAoY2hhbmdlcy5sZW5ndGggPCAyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmaXhlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogYEZpeCBhbGwgJyR7cnVsZU5hbWV9J2AsXG4gICAgICAgICAgICAgICAgY2hhbmdlczogY2hhbmdlcyxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYWRkRGlzYWJsZVJ1bGVGaXgoZml4ZXM6IHRzX21vZHVsZS5Db2RlQWN0aW9uW10sIHByb2JsZW06IHRzbGludC5SdWxlRmFpbHVyZSwgZmlsZU5hbWU6IHN0cmluZywgZmlsZTogdHNfbW9kdWxlLlNvdXJjZUZpbGUpIHtcbiAgICAgICAgICAgIGZpeGVzLnB1c2goe1xuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBgRGlzYWJsZSBydWxlICcke3Byb2JsZW0uZ2V0UnVsZU5hbWUoKX0nYCxcbiAgICAgICAgICAgICAgICBjaGFuZ2VzOiBbe1xuICAgICAgICAgICAgICAgICAgICBmaWxlTmFtZTogZmlsZU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRleHRDaGFuZ2VzOiBbe1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3VGV4dDogYC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZToke3Byb2JsZW0uZ2V0UnVsZU5hbWUoKX1cXG5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgc3BhbjogeyBzdGFydDogZmlsZS5nZXRMaW5lU3RhcnRzKClbcHJvYmxlbS5nZXRTdGFydFBvc2l0aW9uKCkuZ2V0TGluZUFuZENoYXJhY3RlcigpLmxpbmVdLCBsZW5ndGg6IDAgfVxuICAgICAgICAgICAgICAgICAgICB9XVxuICAgICAgICAgICAgICAgIH1dXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGFkZE9wZW5Db25maWd1cmF0aW9uRml4KGZpeGVzOiB0c19tb2R1bGUuQ29kZUFjdGlvbltdKSB7XG4gICAgICAgICAgICAvLyB0aGUgT3BlbiBDb25maWd1cmF0aW9uIGNvZGUgYWN0aW9uIGlzIGRpc2FibGVkIHNpbmNlIHRoZXJlIGlzIG5vIHNwZWNpZmllZCBBUEkgdG8gb3BlbiBhbiBlZGl0b3JcbiAgICAgICAgICAgIGxldCBvcGVuQ29uZmlnRml4RW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgaWYgKG9wZW5Db25maWdGaXhFbmFibGVkICYmIGNvbmZpZ0NhY2hlICYmIGNvbmZpZ0NhY2hlLmNvbmZpZ0ZpbGVQYXRoKSB7XG4gICAgICAgICAgICAgICAgZml4ZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBgT3BlbiB0c2xpbnQuanNvbmAsXG4gICAgICAgICAgICAgICAgICAgIGNoYW5nZXM6IFt7XG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlTmFtZTogY29uZmlnQ2FjaGUuY29uZmlnRmlsZVBhdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0Q2hhbmdlczogW11cbiAgICAgICAgICAgICAgICAgICAgfV1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGFkZEFsbEF1dG9GaXhhYmxlKGZpeGVzOiB0c19tb2R1bGUuQ29kZUFjdGlvbltdLCBkb2N1bWVudEZpeGVzOiBNYXA8c3RyaW5nLCB0c2xpbnQuUnVsZUZhaWx1cmU+LCBmaWxlTmFtZTogc3RyaW5nKSB7XG4gICAgICAgICAgICBjb25zdCBhbGxSZXBsYWNlbWVudHMgPSBnZXROb25PdmVybGFwcGluZ1JlcGxhY2VtZW50cyhkb2N1bWVudEZpeGVzKTtcbiAgICAgICAgICAgIGZpeGVzLnB1c2goe1xuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBgRml4IGFsbCBhdXRvLWZpeGFibGUgdHNsaW50IGZhaWx1cmVzYCxcbiAgICAgICAgICAgICAgICBjaGFuZ2VzOiBbe1xuICAgICAgICAgICAgICAgICAgICBmaWxlTmFtZTogZmlsZU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRleHRDaGFuZ2VzOiBhbGxSZXBsYWNlbWVudHMubWFwKGVhY2ggPT4gY29udmVydFJlcGxhY2VtZW50VG9UZXh0Q2hhbmdlKGVhY2gpKVxuICAgICAgICAgICAgICAgIH1dXG4gICAgICAgICAgICB9KTsgXG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRSZXBsYWNlbWVudChmYWlsdXJlOiB0c2xpbnQuUnVsZUZhaWx1cmUsIGF0Om51bWJlcik6IHRzbGludC5SZXBsYWNlbWVudCB7XG4gICAgICAgICAgICByZXR1cm4gZ2V0UmVwbGFjZW1lbnRzKGZhaWx1cmUuZ2V0Rml4KCkpW2F0XTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNvcnRGYWlsdXJlcyhmYWlsdXJlczogdHNsaW50LlJ1bGVGYWlsdXJlW10pOnRzbGludC5SdWxlRmFpbHVyZVtdIHtcblx0ICAgICAgICAvLyBUaGUgZmFpbHVyZXMucmVwbGFjZW1lbnRzIGFyZSBzb3J0ZWQgYnkgcG9zaXRpb24sIHdlIHNvcnQgb24gdGhlIHBvc2l0aW9uIG9mIHRoZSBmaXJzdCByZXBsYWNlbWVudFxuICAgICAgICAgICAgcmV0dXJuIGZhaWx1cmVzLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZ2V0UmVwbGFjZW1lbnQoYSwgMCkuc3RhcnQgLSBnZXRSZXBsYWNlbWVudChiLCAwKS5zdGFydDtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0Tm9uT3ZlcmxhcHBpbmdSZXBsYWNlbWVudHMoZG9jdW1lbnRGaXhlczogTWFwPHN0cmluZywgdHNsaW50LlJ1bGVGYWlsdXJlPik6IHRzbGludC5SZXBsYWNlbWVudFtdIHtcbiAgICAgICAgICAgIGZ1bmN0aW9uIG92ZXJsYXBzKGE6IHRzbGludC5SZXBsYWNlbWVudCwgYjogdHNsaW50LlJlcGxhY2VtZW50KTogYm9vbGVhbiB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGEuZW5kID49IGIuc3RhcnQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBzb3J0ZWRGYWlsdXJlcyA9IHNvcnRGYWlsdXJlcyhbLi4uZG9jdW1lbnRGaXhlcy52YWx1ZXMoKV0pO1xuICAgICAgICAgICAgbGV0IG5vbk92ZXJsYXBwaW5nOiB0c2xpbnQuUmVwbGFjZW1lbnRbXSA9IFtdO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzb3J0ZWRGYWlsdXJlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgIGxldCByZXBsYWNlbWVudHMgPSBnZXRSZXBsYWNlbWVudHMoc29ydGVkRmFpbHVyZXNbaV0uZ2V0Rml4KCkpO1xuICAgICAgICAgICAgICAgIGlmIChpID09PSAwIHx8ICFvdmVybGFwcyhub25PdmVybGFwcGluZ1tub25PdmVybGFwcGluZy5sZW5ndGggLSAxXSwgcmVwbGFjZW1lbnRzWzBdKSkge1xuICAgICAgICAgICAgICAgICAgICBub25PdmVybGFwcGluZy5wdXNoKC4uLnJlcGxhY2VtZW50cylcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gbm9uT3ZlcmxhcHBpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBwcm94eS5nZXRTZW1hbnRpY0RpYWdub3N0aWNzID0gKGZpbGVOYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHByaW9yID0gb2xkTFMuZ2V0U2VtYW50aWNEaWFnbm9zdGljcyhmaWxlTmFtZSk7XG5cbiAgICAgICAgICAgIGlmIChjb25maWcuc3VwcmVzc1doaWxlVHlwZUVycm9yc1ByZXNlbnQgJiYgcHJpb3IubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBwcmlvcjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpbmZvLnByb2plY3QucHJvamVjdFNlcnZpY2UubG9nZ2VyLmluZm8oYENvbXB1dGluZyB0c2xpbnQgc2VtYW50aWMgZGlhZ25vc3RpY3MuLi5gKTtcbiAgICAgICAgICAgICAgICBpZiAoY29kZUZpeEFjdGlvbnMuaGFzKGZpbGVOYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBjb2RlRml4QWN0aW9ucy5kZWxldGUoZmlsZU5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChjb25maWcuaWdub3JlRGVmaW5pdGlvbkZpbGVzID09PSB0cnVlICYmIGZpbGVOYW1lLmVuZHNXaXRoKCcuZC50cycpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBwcmlvcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmF0aW9uID0gZ2V0Q29uZmlndXJhdGlvbihmaWxlTmFtZSwgY29uZmlnLmNvbmZpZ0ZpbGUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY29uZmlndXJhdGlvbi5saW50ZXJPcHRpb25zICYmXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25maWd1cmF0aW9uLmxpbnRlck9wdGlvbnMuZXhjbHVkZSAmJlxuICAgICAgICAgICAgICAgICAgICAgICAgY29uZmlndXJhdGlvbi5saW50ZXJPcHRpb25zLmV4Y2x1ZGUuc29tZShmdW5jdGlvbiAocGF0dGVybikgeyByZXR1cm4gbmV3IG1pbmltYXRjaC5NaW5pbWF0Y2gocGF0dGVybikubWF0Y2goZmlsZU5hbWUpIH0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gcHJpb3I7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gVE9ETzogc2hvdyB0aGUgcmVhc29uIGZvciB0aGUgY29uZmlndXJhdGlvbiBmYWlsdXJlIHRvIHRoZSB1c2VyIGFuZCBub3Qgb25seSBpbiB0aGUgbG9nXG4gICAgICAgICAgICAgICAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9NaWNyb3NvZnQvVHlwZVNjcmlwdC9pc3N1ZXMvMTU5MTNcbiAgICAgICAgICAgICAgICAgICAgaW5mby5wcm9qZWN0LnByb2plY3RTZXJ2aWNlLmxvZ2dlci5pbmZvKGdldENvbmZpZ3VyYXRpb25GYWlsdXJlTWVzc2FnZShlcnIpKVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcHJpb3I7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJlc3VsdDogdHNsaW50LkxpbnRSZXN1bHQ7XG5cbiAgICAgICAgICAgICAgICAvLyB0c2xpbnQgd3JpdGVzIHdhcm5pbmcgbWVzc2FnZXMgdXNpbmcgY29uc29sZS53YXJuKClcbiAgICAgICAgICAgICAgICAvLyBjYXB0dXJlIHRoZSB3YXJuaW5ncyBhbmQgd3JpdGUgdGhlbSB0byB0aGUgdHNsaW50IHBsdWdpbiBsb2dcbiAgICAgICAgICAgICAgICBsZXQgd2FybiA9IGNvbnNvbGUud2FybjtcbiAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4gPSBjYXB0dXJlV2FybmluZ3M7XG5cbiAgICAgICAgICAgICAgICB0cnkgeyAvLyBwcm90ZWN0IGFnYWluc3QgdHNsaW50IGNyYXNoZXNcbiAgICAgICAgICAgICAgICAgICAgLy8gVE9ETyB0aGUgdHlwZXMgb2YgdGhlIFByb2dyYW0gcHJvdmlkZWQgYnkgdHNzZXJ2ZXIgbGliYXJ5IGFyZSBub3QgY29tcGF0aWJsZSB3aXRoIHRoZSBvbmUgcHJvdmlkZWQgYnkgdHlwZXNjcmlwdFxuICAgICAgICAgICAgICAgICAgICAvLyBjYXN0aW5nIGF3YXkgdGhlIHR5cGVcbiAgICAgICAgICAgICAgICAgICAgbGV0IG9wdGlvbnM6IHRzbGludC5JTGludGVyT3B0aW9ucyA9IHsgZml4OiBmYWxzZSB9O1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGludGVyID0gbmV3IHRzbGludC5MaW50ZXIob3B0aW9ucywgPGFueT5vbGRMUy5nZXRQcm9ncmFtKCkpO1xuICAgICAgICAgICAgICAgICAgICBsaW50ZXIubGludChmaWxlTmFtZSwgXCJcIiwgY29uZmlndXJhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdCA9IGxpbnRlci5nZXRSZXN1bHQoKTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGVycm9yTWVzc2FnZSA9IGB1bmtub3duIGVycm9yYDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBlcnIubWVzc2FnZSA9PT0gJ3N0cmluZycgfHwgZXJyLm1lc3NhZ2UgaW5zdGFuY2VvZiBTdHJpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yTWVzc2FnZSA9IDxzdHJpbmc+ZXJyLm1lc3NhZ2U7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaW5mby5wcm9qZWN0LnByb2plY3RTZXJ2aWNlLmxvZ2dlci5pbmZvKCd0c2xpbnQgZXJyb3IgJyArIGVycm9yTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBwcmlvcjtcbiAgICAgICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4gPSB3YXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQuZmFpbHVyZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCB0c2xpbnRQcm9ibGVtcyA9IGZpbHRlclByb2JsZW1zRm9yRG9jdW1lbnQoZmlsZU5hbWUsIHJlc3VsdC5mYWlsdXJlcyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0c2xpbnRQcm9ibGVtcyAmJiB0c2xpbnRQcm9ibGVtcy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpbGUgPSBvbGRMUy5nZXRQcm9ncmFtKCkuZ2V0U291cmNlRmlsZShmaWxlTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkaWFnbm9zdGljcyA9IHByaW9yID8gWy4uLnByaW9yXSA6IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgdHNsaW50UHJvYmxlbXMuZm9yRWFjaChwcm9ibGVtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaWFnbm9zdGljcy5wdXNoKG1ha2VEaWFnbm9zdGljKHByb2JsZW0sIGZpbGUpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRDb2RlQWN0aW9uKHByb2JsZW0sIGZpbGUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZGlhZ25vc3RpY3M7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgaW5mby5wcm9qZWN0LnByb2plY3RTZXJ2aWNlLmxvZ2dlci5pbmZvKGB0c2xpbnQtbGFuZ3VhZ2Ugc2VydmljZSBlcnJvcjogJHtlLnRvU3RyaW5nKCl9YCk7XG4gICAgICAgICAgICAgICAgaW5mby5wcm9qZWN0LnByb2plY3RTZXJ2aWNlLmxvZ2dlci5pbmZvKGBTdGFjayB0cmFjZTogJHtlLnN0YWNrfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHByaW9yO1xuICAgICAgICB9O1xuXG4gICAgICAgIHByb3h5LmdldENvZGVGaXhlc0F0UG9zaXRpb24gPSBmdW5jdGlvbiAoZmlsZU5hbWU6IHN0cmluZywgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIsIGVycm9yQ29kZXM6IG51bWJlcltdLCBmb3JtYXRPcHRpb25zOiB0cy5Gb3JtYXRDb2RlU2V0dGluZ3MsIHByZWZlcmVuY2VzOiB0cy5Vc2VyUHJlZmVyZW5jZXMpOiBSZWFkb25seUFycmF5PHRzLkNvZGVGaXhBY3Rpb24+IHtcbiAgICAgICAgICAgIGxldCBwcmlvciA9IG9sZExTLmdldENvZGVGaXhlc0F0UG9zaXRpb24oZmlsZU5hbWUsIHN0YXJ0LCBlbmQsIGVycm9yQ29kZXMsIGZvcm1hdE9wdGlvbnMsIHByZWZlcmVuY2VzKTtcbiAgICAgICAgICAgIGlmIChjb25maWcuc3VwcmVzc1doaWxlVHlwZUVycm9yc1ByZXNlbnQgJiYgcHJpb3IubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBwcmlvcjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaW5mby5wcm9qZWN0LnByb2plY3RTZXJ2aWNlLmxvZ2dlci5pbmZvKFwidHNsaW50LWxhbmd1YWdlLXNlcnZpY2UgZ2V0Q29kZUZpeGVzIFwiICsgZXJyb3JDb2Rlc1swXSk7XG4gICAgICAgICAgICBsZXQgZG9jdW1lbnRGaXhlcyA9IGNvZGVGaXhBY3Rpb25zLmdldChmaWxlTmFtZSk7XG5cbiAgICAgICAgICAgIGlmIChkb2N1bWVudEZpeGVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZml4ZXMgPSBwcmlvciA/IFsuLi5wcmlvcl0gOiBbXTtcblxuICAgICAgICAgICAgICAgIGxldCBwcm9ibGVtID0gZG9jdW1lbnRGaXhlcy5nZXQoY29tcHV0ZUtleShzdGFydCwgZW5kKSk7XG4gICAgICAgICAgICAgICAgaWYgKHByb2JsZW0pIHtcbiAgICAgICAgICAgICAgICAgICAgYWRkUnVsZUZhaWx1cmVGaXgoZml4ZXMsIHByb2JsZW0sIGZpbGVOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgYWRkUnVsZUZhaWx1cmVGaXhBbGwoZml4ZXMsIHByb2JsZW0uZ2V0UnVsZU5hbWUoKSwgZG9jdW1lbnRGaXhlcywgZmlsZU5hbWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBhZGRBbGxBdXRvRml4YWJsZShmaXhlcywgZG9jdW1lbnRGaXhlcywgZmlsZU5hbWUpO1xuICAgICAgICAgICAgICAgIGlmIChwcm9ibGVtKSB7XG4gICAgICAgICAgICAgICAgICAgIGFkZE9wZW5Db25maWd1cmF0aW9uRml4KGZpeGVzKTtcbiAgICAgICAgICAgICAgICAgICAgYWRkRGlzYWJsZVJ1bGVGaXgoZml4ZXMsIHByb2JsZW0sIGZpbGVOYW1lLCBvbGRMUy5nZXRQcm9ncmFtKCkuZ2V0U291cmNlRmlsZShmaWxlTmFtZSkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmaXhlcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHByaW9yO1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gcHJveHk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgY3JlYXRlIH07XG59XG5cbmV4cG9ydCA9IGluaXQ7XG5cbi8qIEBpbnRlcm5hbCAqL1xuLy8gd29yayBhcm91bmQgZm9yIG1pc3NpbmcgQVBJIHRvIHJlZ2lzdGVyIGEgY29kZSBmaXhcbm5hbWVzcGFjZSBjb2RlZml4IHtcblxuICAgIGV4cG9ydCBpbnRlcmZhY2UgQ29kZUZpeCB7XG4gICAgICAgIGVycm9yQ29kZXM6IG51bWJlcltdO1xuICAgICAgICBnZXRDb2RlQWN0aW9ucyhjb250ZXh0OiBhbnkpOiB0cy5Db2RlQWN0aW9uW10gfCB1bmRlZmluZWQ7XG4gICAgfVxufVxuIl19