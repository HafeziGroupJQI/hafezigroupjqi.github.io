#!/usr/bin/env wolframscript
(* Stage 1 of the site's notebook step: render every Wolfram notebook under a content root to
   block JSON (WolframNotebook.wl), from the outputs stored in each notebook. Stage 2 is
   tools/notebooks/wolfram-pages.mjs (pages + assets); tools/notebooks/render-notebooks.mjs runs
   both during the site build.

   wolframscript -file render-nb.wls --root <content dir> --out <dir>
     [--cache ~/.cache/hafezi-notebooks] [--jobs N] [--force] [--salt s]

   Output:
     <out>/notebooks/<path>.json   one per notebook, mirroring its path under the root
     <out>/symbols.json            System` names + usage (the editor's autocomplete)
     <out>/render.json             run summary: versions, per-notebook source sha, cache, stats
   Exit status 1 if any notebook or cell failed to render.

   Licensing: one kernel plus at most --jobs subkernels (default 2, max 3). The headless front end
   is a player process, not a kernel license. Notebooks over 15 MB render one at a time on the
   main kernel. *)

$here = DirectoryName[$InputFileName];
Get[FileNameJoin[{$here, "WolframNotebook.wl"}]];

args = Rest[$ScriptCommandLine];
opt[name_, default_] := With[{p = FirstPosition[args, "--" <> name]},
   If[MissingQ[p] || p === {} || p[[1]] >= Length[args], default, args[[p[[1]] + 1]]]];
flag[name_] := MemberQ[args, "--" <> name];

root = opt["root", None];
out = opt["out", None];
If[!StringQ[root] || !StringQ[out], Print["usage: render-nb.wls --root <content dir> --out <dir> [--cache dir] [--jobs N] [--force]"]; Exit[2]];
root = ExpandFileName[root]; out = ExpandFileName[out];
cache = ExpandFileName[StringReplace[opt["cache", FileNameJoin[{$HomeDirectory, ".cache", "hafezi-notebooks"}]], StartOfString ~~ "~" -> $HomeDirectory]];
jobs = Clip[ToExpression[opt["jobs", "2"]], {0, 3}];
force = flag["force"];
memLimit = 6*2^30;
bigBytes = 15*10^6;

WolframNotebook`$CacheDir = cache;
WolframNotebook`$Salt = salt = opt["salt", ""];
Quiet[CreateDirectory[FileNameJoin[{out, "notebooks"}], CreateIntermediateDirectories -> True]];

(* Every .nb under the root, except in hidden directories (.git, .quarto, ...). *)
files = Select[FileNames["*.nb", root, Infinity],
   FreeQ[FileNameSplit[StringDrop[#, StringLength[root]]], _String?(StringStartsQ[#, "."] &)] &];
Print["notebooks: ", Length[files], "  root: ", root, "  cache: ", cache, "  jobs: ", jobs, If[force, "  (forced)", ""]];

(* One notebook, guarded: memory and a generous overall time limit. *)
renderOne[file_, force_] := Module[{r, t = AbsoluteTime[], rel = WolframNotebook`Private`relPath[file, root]},
   r = MemoryConstrained[
     TimeConstrained[UsingFrontEnd[WolframNotebook`ExportNotebook[file, "Force" -> force, "Root" -> root]], 3600, $TimedOut],
     memLimit, $Aborted];
   If[AssociationQ[r],
    WolframNotebook`WriteJSON[FileNameJoin[{out, "notebooks", rel <> ".json"}], KeyDrop[r, "notebook_cache"]];
    <|"source" -> rel, "page" -> r["page"], "source_sha" -> r["source_sha"], "cache" -> r["notebook_cache"],
      "stats" -> r["stats"], "seconds" -> N[Round[AbsoluteTime[] - t, 1/10]]|>,
    <|"source" -> rel, "error" -> ToString[r], "seconds" -> N[Round[AbsoluteTime[] - t, 1/10]]|>]];

report[r_] := Print[r["source"], "  ", If[KeyExistsQ[r, "error"], "ERROR " <> r["error"],
     r["cache"] <> " cells=" <> ToString[r["stats"]["cells"]] <> " rendered=" <> ToString[r["stats"]["exported"]] <>
      " failed=" <> ToString[Length[r["stats"]["failed"]]]], "  ", r["seconds"], "s"];

(* Launch subkernels, retrying while another process holds the licenses. *)
launch[n_] := Module[{k = {}, tries = 0},
   While[Length[k] < n && tries < 20,
    k = Join[k, Quiet@Check[LaunchKernels[n - Length[k]], {}]];
    If[Length[k] < n, tries++; Print["waiting for a license (", Length[k], "/", n, " subkernels)"]; Pause[30]]];
   k];

(* Cached notebooks need no subkernels: only uncached small ones are spread over the pool. *)
cachedQ = If[force, False &, WolframNotebook`NotebookCachedQ];
cachedSmall = Select[files, FileByteCount[#] <= bigBytes && cachedQ[#] &];
small = Complement[Select[files, FileByteCount[#] <= bigBytes &], cachedSmall];
big = SortBy[Select[files, FileByteCount[#] > bigBytes &], FileByteCount];
results = {};

UsingFrontEnd[
  If[jobs > 0 && Length[small] > 1,
   kernels = launch[Min[jobs, Length[small]]];
   If[kernels =!= {},
    With[{pkg = FileNameJoin[{$here, "WolframNotebook.wl"}], c = cache, f = force, salt = salt},
     (* Loaded on first use in each subkernel, not once up front: a subkernel that crashes is
        relaunched by the parallel tools without anything ParallelEvaluate set up. *)
     ensureRenderer[] := If[!TrueQ[rendererLoaded],
       Get[pkg]; WolframNotebook`$CacheDir = c; WolframNotebook`$Salt = salt; rendererLoaded = True];
     DistributeDefinitions[ensureRenderer, renderOne, root, out, memLimit];
     results = ParallelMap[(ensureRenderer[]; renderOne[#, f]) &, SortBy[small, -FileByteCount[#] &],
       Method -> "FinestGrained", DistributedContexts -> None];
     (* A notebook that failed on a subkernel is rendered again below, in this kernel. *)
     retry = Select[results, KeyExistsQ[#, "error"] &];
     results = Complement[results, retry];
     report /@ results;
     If[retry =!= {}, Print[Length[retry], " notebook(s) failed on a subkernel; rendering them here"]];
     CloseKernels[kernels]],
    Print["no subkernels available; rendering serially"]]];
  (* Anything not done in parallel (and every big notebook) runs here, one at a time. *)
  Do[With[{r = renderOne[file, force]}, report[r]; AppendTo[results, r]],
   {file, Join[Complement[small, Lookup[results, "source", {}] /. rel_String :> FileNameJoin[{root, rel}]],
     cachedSmall, big]}];
  symbols = If[files === {}, {}, WolframNotebook`ExportSymbols[]];
  ];

WolframNotebook`WriteJSON[FileNameJoin[{out, "symbols.json"}], symbols];
failed = Select[results, KeyExistsQ[#, "error"] || Length[#["stats"]["failed"]] > 0 &];
summary = <|
   "renderer" -> "wolfram",
   "exporter_version" -> WolframNotebook`$ExporterVersion,
   "wolfram_version" -> $VersionNumber,
   "root" -> root,
   "cache" -> cache,
   "forced" -> force,
   "notebooks" -> Length[results],
   "notebook_cache_hits" -> Count[results, _?(Lookup[#, "cache"] === "hit" &)],
   "cells" -> Total[Lookup[Lookup[results, "stats", <||>], "cells", 0]],
   "cells_rendered" -> Total[Lookup[Lookup[results, "stats", <||>], "exported", 0]],
   "failed" -> Lookup[failed, "source", {}],
   "results" -> SortBy[results, #["source"] &]|>;
WolframNotebook`WriteJSON[FileNameJoin[{out, "render.json"}], summary];
Print["done: ", summary["notebooks"], " notebooks, ", summary["notebook_cache_hits"], " cached; ",
  summary["cells"], " cells, ", summary["cells_rendered"], " rendered; ", Length[failed], " with failures"];
Exit[If[Length[failed] > 0, 1, 0]];
