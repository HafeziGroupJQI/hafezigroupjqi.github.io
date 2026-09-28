(* Tests for WolframNotebook.wl. Fixtures are cut at test time from real notebooks in
   $NotebookDir (WOLFRAM_NOTEBOOKS_DIR), so no notebook content lives in this repo.
   Run with: wolframscript -file tools/notebooks/tests/run.wls *)

Needs["WolframNotebook`", FileNameJoin[{DirectoryName[$TestFileName], "..", "WolframNotebook.wl"}]];
nbCells[name_] := WolframNotebook`FlattenCells[First@Get[FileNameJoin[{$NotebookDir, name}]]];
outputs[name_] := Cases[nbCells[name], Cell[BoxData[b_], "Output", ___] :> b];
inputs[name_] := Cases[nbCells[name], Cell[BoxData[b_], "Input", ___] :> b];

(* ---- style map ---- *)
VerificationTest[
  CellKind /@ {"CodeCaption", "Input", "Output", "Text", "TechNote", "Question", "Answer",
    "VocabularyTable", "MoreExplore", "Exercise", "ExerciseOutput", "ExerciseExpectedResult",
    "QASection", "Subsection", "SectionInline", "CodeSectionDividerCloud", "SomethingNew"},
  {"caption", "input", "output", "p", "technote", "question", "answer", "vocab", "more",
   "exercise", "expected", "skip", "h2", "h3", "section", "skip", "p"},
  TestID -> "style-map"]

VerificationTest[
  FlattenCells[{Cell["a", "Text"], Cell[CellGroupData[{Cell["b", "Section"],
      Cell[CellGroupData[{Cell["c", "Input"], Cell["d", "Output"]}, Open]]}, Closed]]}],
  {Cell["a", "Text"], Cell["b", "Section"], Cell["c", "Input"], Cell["d", "Output"]},
  TestID -> "flatten-groups"]

(* ---- InputText round trip: every chapter 4 input parses back to the same held expression ---- *)
VerificationTest[
  Select[inputs["EIWL3-04-displaying-lists.nb"], Function[b,
     ToExpression[InputCode[b], InputForm, HoldComplete] =!= ToExpression[b, StandardForm, HoldComplete]]],
  {}, TestID -> "inputtext-roundtrip-ch04"]

VerificationTest[
  With[{b = RowBox[{"{", RowBox[{RowBox[{"a", "\[Rule]", "\[Pi]"}], ",", RowBox[{"x", "\[Function]", SuperscriptBox["x", "2"]}]}], "}"}]},
   ToExpression[InputCode[b], InputForm, HoldComplete] === ToExpression[b, StandardForm, HoldComplete]],
  True, TestID -> "inputtext-roundtrip-operators"]

VerificationTest[
  DefinitionQ /@ {"x = 5", "f[x_] := x^2", "a = 1; b = 2", "Table[x = 1, 3]", "2 + 2", "Module[{y = 1}, y]"},
  {True, True, True, False, False, False}, TestID -> "definition-detection"]

(* ---- box classification on fixtures cut from chapters 4, 9, 24, 46 ---- *)
VerificationTest[Union[OutputKind /@ Take[outputs["EIWL3-01-starting-out-elementary-arithmetic.nb"], 3]], {"text"}, TestID -> "classify-ch01-text"]
VerificationTest[MemberQ[OutputKind /@ outputs["EIWL3-04-displaying-lists.nb"], "typeset"], True, TestID -> "classify-ch04-graphics"]
VerificationTest[OutputKind[First@outputs["EIWL3-09-interactive-manipulation.nb"]], "manipulate", TestID -> "classify-ch09-manipulate"]
VerificationTest[MemberQ[OutputKind /@ outputs["EIWL3-24-more-forms-of-visualization.nb"], "graphics3d"], True, TestID -> "classify-ch24-3d"]
(* Quiet: the first use of audio in a fresh kernel can print a one-time paclet message; the
   classification itself is pure. *)
VerificationTest[With[{k = Quiet[OutputKind /@ outputs["EIWL3-46-audio-and-video.nb"]]}, {MemberQ[k, "audio"], MemberQ[k, "video"], MemberQ[k, "image" | "typeset"]}], {True, True, True}, TestID -> "classify-ch46-media"]
VerificationTest[BoxText[RowBox[{"{", RowBox[{"1", ",", "\"a\"", ",", " ", "2"}], "}"}]], "{1, a, 2}", TestID -> "boxtext-strings"]
VerificationTest[BoxText[GraphicsBox[DiskBox[{0, 0}]]], $Failed, TestID -> "boxtext-graphics-fails"]

(* ---- graphs and charts: seeded only where the front end initializes in the kernel ---- *)
netGraph[name_] := FirstCase[outputs[name], b_ /; !FreeQ[b, NamespaceBox["NetworkGraphics", __]], $Failed];
pieChart[name_] := FirstCase[outputs[name], b_ /; StringContainsQ[ToString[b, InputForm], "DynamicChart`click"], $Failed];
pieList[name_] := FirstCase[outputs[name], b : RowBox[{"{", RowBox[{_GraphicsBox, ",", ___}], "}"}] /;
     StringContainsQ[ToString[b, InputForm], "DynamicChart`click"], $Failed];
(* Whether an SVG asset (as pages show these outputs) draws its content: not an empty white box, and
   not the front end's pink box for a dynamic module it could not draw. *)
drawn[a_Association] := With[{svg = ReadString[FileNameJoin[{WolframNotebook`$CacheDir, "assets", a["sha"] <> "." <> a["ext"]}]]},
   StringFreeQ[svg, "fill:rgb(100%,33%,33%)"] && StringCount[svg, "<path" | "<use" | "<image"] > 3];
drawn[_] := False;

VerificationTest[
  With[{g = netGraph["EIWL3-21-graphs-and-networks.nb"], p = pieChart["EIWL3-04-displaying-lists.nb"],
    m = First@outputs["EIWL3-09-interactive-manipulation.nb"]},
   {g =!= $Failed, p =!= $Failed, WolframNotebook`Private`seedDynamics[g, 7] === g,
    WolframNotebook`Private`seedDynamics[p, 7] === p, !FreeQ[WolframNotebook`Private`seedDynamics[m, 7], HoldPattern[SeedRandom[7]]]}],
  {True, True, True, True, True}, TestID -> "seed-only-synchronous-modules"]

(* A Graph, a PieChart and a list of pie charts are drawn, not left as an empty white box. *)
VerificationTest[
  Module[{dir = CreateDirectory[], r},
   WolframNotebook`$CacheDir = dir;
   r = drawn[WolframNotebook`Private`renderBoxes[#, "Output", "svg"]] & /@ {
      netGraph["EIWL3-21-graphs-and-networks.nb"], pieChart["EIWL3-04-displaying-lists.nb"],
      pieList["EIWL3-04-displaying-lists.nb"]};
   DeleteDirectory[dir, DeleteContents -> True]; r],
  {True, True, True}, TestID -> "render-graph-and-pie-charts"]

(* ---- a page is the notebook's path; the title is the notebook's own ---- *)
VerificationTest[
  PageInfo["/site/content/resources/code/wolfram-guide/EIWL3-04-displaying-lists.nb", "/site/content"],
  <|"page" -> "resources/code/wolfram-guide/EIWL3-04-displaying-lists", "source" -> "resources/code/wolfram-guide/EIWL3-04-displaying-lists.nb"|>,
  TestID -> "page-is-path"]

VerificationTest[
  Module[{dir = CreateDirectory[], file, r},
   WolframNotebook`$CacheDir = FileNameJoin[{dir, "cache"}];
   file = FileNameJoin[{dir, "sub", "My notes.nb"}];
   CreateDirectory[DirectoryName[file]];
   (* A notebook made here, not from any book: text, a stored output, a link to a sibling. *)
   Put[Notebook[{Cell["Ring resonators", "Title"], Cell["Some text.", "Text"],
       Cell[BoxData[RowBox[{"1", "+", "1"}]], "Input"], Cell[BoxData["2"], "Output"],
       Cell[TextData[{"See ", ButtonBox["other", BaseStyle -> "Hyperlink", ButtonData -> {"My Other & More.nb", None}]}], "Text"]}], file];
   r = ExportNotebook[file, "Root" -> dir];
   DeleteDirectory[dir, DeleteContents -> True];
   {r["page"], r["source"], r["title"], Lookup[r["blocks"], "t"], r["blocks"][[2]]["code"], r["blocks"][[3]]["out"]["text"],
    StringContainsQ[r["blocks"][[4]]["html"], "class=\"internal\" href=\"{{nb:My Other &amp; More.nb}}\""]}],
  {"sub/My notes", "sub/My notes.nb", "Ring resonators", {"p", "input", "output", "p"}, "1 + 1", "2", True},
  TestID -> "any-notebook"]

VerificationTest[
  Module[{dir = CreateDirectory[], file, title},
   WolframNotebook`$CacheDir = FileNameJoin[{dir, "cache"}];
   file = FileNameJoin[{dir, "EIWL3-01.nb"}];
   CopyFile[FileNameJoin[{$NotebookDir, "EIWL3-01-starting-out-elementary-arithmetic.nb"}], file];
   title = ExportNotebook[file, "Root" -> dir]["title"];
   DeleteDirectory[dir, DeleteContents -> True];
   title],
  "Starting Out: Elementary Arithmetic: Elementary Introduction to the Wolfram Language",
  TestID -> "title-from-window-title"]

(* ---- caching: a second run renders nothing; changing one cell re-renders one ---- *)
VerificationTest[
  Module[{dir = CreateDirectory[], src, nb, file, cells, r1, r2, r3, pos},
   WolframNotebook`$CacheDir = FileNameJoin[{dir, "cache"}];
   src = Get[FileNameJoin[{$NotebookDir, "EIWL3-04-displaying-lists.nb"}]];
   nb = Notebook[Take[First[src], UpTo[6]], Sequence @@ Rest[src]];
   file = FileNameJoin[{dir, "EIWL3-04-displaying-lists.nb"}];
   Put[nb, file];
   r1 = ExportNotebook[file]["stats"]["exported"];
   (* Forced: the notebook is re-walked, every cell comes from the per-cell cache. *)
   r2 = ExportNotebook[file, "Force" -> True]["stats"]["exported"];
   pos = First@Position[nb, Cell[BoxData[_], "Input", ___]];
   nb = ReplacePart[nb, Append[pos, 1] -> BoxData[RowBox[{"ListPlot", "[", RowBox[{"{", RowBox[{"1", ",", "2"}], "}"}], "]"}]]];
   Put[nb, file];
   r3 = ExportNotebook[file]["stats"]["exported"];
   DeleteDirectory[dir, DeleteContents -> True];
   {r1 > 0, r2, r3}],
  {True, 0, 1}, TestID -> "cache-cells"]

(* ---- the same render gives the same bytes ---- *)
(* PNG: creation metadata chunks go; pixels stay. A tEXt chunk is spliced in after IHDR (33 bytes). *)
VerificationTest[
  Module[{png = ExportByteArray[Graphics[Disk[]], "PNG"], tagged},
   tagged[s_] := Join[png[[1 ;; 33]],
     ByteArray[Join[IntegerDigits[StringLength[s] + 8, 256, 4], ToCharacterCode["tEXtComment" <> FromCharacterCode[0] <> s], {0, 0, 0, 0}]],
     png[[34 ;; -1]]];
   {NormalizeAsset[tagged["2026-09-27T08:00"], "png"] === NormalizeAsset[tagged["2026-09-28T09:30:15"], "png"],
    ImageData[ImportByteArray[NormalizeAsset[tagged["x"], "png"], "PNG"]] === ImageData[ImportByteArray[png, "PNG"]]}],
  {True, True}, TestID -> "normalize-png"]

(* SVG: cairo's session-wide surface ids, and the references to them. *)
VerificationTest[
  With[{svg = StringToByteArray["<svg><g id=\"surface" <> # <> "\"><use xlink:href=\"#surface" <> # <> "\"/></g><rect fill=\"#ff0000\"/></svg>"] &},
   {NormalizeAsset[svg["3591"], "svg"] === NormalizeAsset[svg["2836"], "svg"],
    ByteArrayToString[NormalizeAsset[svg["7"], "svg"]]}],
  {True, "<svg><g id=\"n1\"><use xlink:href=\"#n1\"/></g><rect fill=\"#ff0000\"/></svg>"}, TestID -> "normalize-svg"]

(* Ogg: every export picks a random stream serial; normalized, two exports are identical and valid. *)
VerificationTest[
  Module[{a = Audio[Table[Sin[440. 2 Pi t], {t, 0, 0.25, 1/8000.}], SampleRate -> 8000], x, y},
   x = ExportByteArray[a, "OGG"]; y = ExportByteArray[a, "OGG"];
   {x =!= y, NormalizeAsset[x, "ogg"] === NormalizeAsset[y, "ogg"], AudioQ[ImportByteArray[NormalizeAsset[x, "ogg"], "OGG"]]}],
  {True, True, True}, TestID -> "normalize-ogg"]

(* Editing the renderer (its file hash) changes every cache key; nothing stale is ever served. *)
VerificationTest[
  Module[{dir = CreateDirectory[], file, k1, k2},
   file = FileNameJoin[{dir, "a.nb"}]; Put[Notebook[{Cell["x", "Text"]}], file];
   k1 = NotebookKey[file];
   k2 = Block[{$RendererHash = "edited"}, NotebookKey[file]];
   DeleteDirectory[dir, DeleteContents -> True];
   {StringLength[$RendererHash], k1 =!= k2}],
  {64, True}, TestID -> "renderer-hash-in-keys"]
