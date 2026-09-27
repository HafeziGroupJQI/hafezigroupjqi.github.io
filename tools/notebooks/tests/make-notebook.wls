#!/usr/bin/env wolframscript
(* Write a Wolfram notebook that has nothing to do with any book: its inputs are evaluated here
   and their outputs saved into the notebook, as a member's notebook would be after running it.
   tools/notebooks/prove.sh adds it to the content to show the site renders any notebook.

     wolframscript -file make-notebook.wls <out.nb> [revision]
   A revision adds one cell saying so: prove.sh's warm deploy changes the notebook that way. *)

args = Rest[$ScriptCommandLine];
out = If[args === {}, "", First[args]];
revision = If[Length[args] > 1, args[[2]], ""];
If[!StringEndsQ[out, ".nb"], Print["usage: make-notebook.wls <out.nb> [revision]"]; Exit[2]];

(* An input cell and the output cell(s) evaluating it gives, as the front end would save them. *)
pair[code_String] := Module[{held = ToExpression[code, InputForm, HoldComplete], value},
   value = ReleaseHold[held];
   {Cell[BoxData[MakeBoxes @@ (held /. HoldComplete[x_] :> HoldComplete[x] /. HoldComplete -> Defer)], "Input"],
    (* Like the front end: a definition (Null result) saves no output cell. *)
    If[value === Null, Nothing, Cell[BoxData[ToBoxes[value, StandardForm]], "Output"]]}];

nb = Notebook[Flatten[{
     Cell["Ring resonator notes (made by prove.sh)", "Title"],
     Cell["A notebook written for the site's notebook step: text, a definition, numbers, a table, 2D and 3D graphics, and a Manipulate.", "Text"],
     Cell["Definitions", "Section"],
     pair["fsr[ng_, L_] := 299792458/(ng L)"],
     pair["N[fsr[2.1, 1.2*^-3]]"],
     pair["Grid[Table[{n, n^2, Prime[n]}, {n, 5}]]"],
     Cell["Figures", "Section"],
     pair["Plot[Sin[x]/x, {x, -10, 10}, PlotRange -> All]"],
     pair["Plot3D[Sin[x y], {x, 0, 3}, {y, 0, 3}]"],
     pair["Manipulate[Plot[Sin[k x], {x, 0, 2 Pi}], {k, 1, 4, 1}]"],
     Cell[TextData[{"The sibling notebook ", ButtonBox["notes", BaseStyle -> "Hyperlink", ButtonData -> {"notes.nb", None}],
        " is linked by name; ", ButtonBox["a notebook that isn't here", BaseStyle -> "Hyperlink", ButtonData -> {"missing.nb", None}],
        " is not."}], "Text"],
     If[revision === "", Nothing, Cell["Revised: " <> revision, "Text"]]
     }], WindowTitle -> "Ring resonator notes"];

(* Graphics output boxes need the front end to be typeset the way a saved notebook has them. *)
UsingFrontEnd[Put[nb, out]];
(* The sibling it links to. *)
Put[Notebook[{Cell["Notes", "Title"], Cell["The notebook the ring resonator notes link to.", "Text"]}],
  FileNameJoin[{DirectoryName[out], "notes.nb"}]];
Print["wrote ", out, " (", FileByteCount[out], " bytes, ", Length[First[nb]], " cells) and notes.nb"];
