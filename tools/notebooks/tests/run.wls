#!/usr/bin/env wolframscript
(* Tests for WolframNotebook.wl. Fixtures are cut at test time from real notebooks, so no notebook
   content lives in this repo:
     WOLFRAM_NOTEBOOKS_DIR=<dir with EIWL3-*.nb, e.g. vault-private/code/wolfram-guide> \
       wolframscript -file tools/notebooks/tests/run.wls *)
$NotebookDir = Environment["WOLFRAM_NOTEBOOKS_DIR"];
If[!StringQ[$NotebookDir] || !DirectoryQ[$NotebookDir], Print["set WOLFRAM_NOTEBOOKS_DIR to a directory of Wolfram notebooks (EIWL3-*.nb)"]; Exit[2]];
report = UsingFrontEnd[TestReport[FileNameJoin[{DirectoryName[$InputFileName], "WolframNotebook.wlt"}]]];
Do[If[t["Outcome"] =!= "Success", Print["FAIL ", t["TestID"], ": ", t["Outcome"], "\n  expected ", Short[t["ExpectedOutput"], 3], "\n  actual   ", Short[t["ActualOutput"], 3]]], {t, Values[report["TestResults"]]}];
Print[report["TestsSucceededCount"], " passed, ", report["TestsFailedCount"], " failed"];
Exit[If[report["AllTestsSucceeded"], 0, 1]];
