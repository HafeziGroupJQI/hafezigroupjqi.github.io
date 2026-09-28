(* ::Package:: *)

(* WolframNotebook: renders any Wolfram notebook (.nb) in the site's content into block JSON
   that tools/notebooks/wolfram-pages.mjs turns into a page, the way Quarto renders an .ipynb:
   from the outputs stored in the notebook, without evaluating it. Nothing here is specific to
   one book or folder; a notebook's page is its path in the content tree.

   Everything the renderer produces is cached under $CacheDir, keyed by what it was made from:
     notebooks/<key>.json  a finished notebook; key = sha256(file bytes) | renderer version |
                           $VersionNumber | options
     cells/<key>.json      one rendered cell; key = Hash[{cell, stylesheet}] | renderer version
     boxes/<key>.json      one rendered box expression (identical outputs render once)
     assets/<sha256>.<ext> the rendered files, content addressed
   A cache hit therefore only ever returns what the same source would render to; the proof
   script (tools/notebooks/prove.sh) renders with an empty cache to show it.
   Rendering needs the front end (UsingFrontEnd). *)

BeginPackage["WolframNotebook`"];

$ExporterVersion::usage = "The renderer's version label (shown in page metadata).";
$RendererHash::usage = "SHA-256 of this file: part of every cache key, so editing the renderer invalidates its caches.";
$Salt::usage = "Extra cache-key salt (development).";
$CacheDir::usage = "Cache root (notebooks/, cells/, boxes/, assets/).";
$Stats::usage = "Counters for the current notebook: cells, cached, exported, failed.";
FlattenCells::usage = "FlattenCells[cells] flattens CellGroupData into document order.";
CellKind::usage = "CellKind[style] maps a notebook cell style to the block kind it renders as.";
InputCode::usage = "InputCode[boxes] is the InputText of an input cell (front end ExportPacket).";
DefinitionQ::usage = "DefinitionQ[code] is True when the code makes a top-level definition.";
BoxText::usage = "BoxText[boxes, quotes] is plain text for text-only boxes, or $Failed.";
OutputKind::usage = "OutputKind[boxes] classifies an output box expression.";
PageInfo::usage = "PageInfo[file, root] gives the page (the notebook's path under root, without .nb) and source path.";
ExportNotebook::usage = "ExportNotebook[file, opts] renders one notebook (\"Root\" -> content dir) to a page association.";
NotebookKey::usage = "NotebookKey[file] is the notebook-level cache key.";
NotebookCachedQ::usage = "NotebookCachedQ[file] is True when the rendered notebook is cached.";
ExportSymbols::usage = "ExportSymbols[] lists System` symbols with a short usage line.";
WriteJSON::usage = "WriteJSON[path, expr] writes JSON atomically.";
NormalizeAsset::usage = "NormalizeAsset[bytes, ext] strips what makes identical renders differ (timestamps, session ids, random serials).";

Begin["`Private`"];

$ExporterVersion = "5";
(* Every cache key includes the renderer's own bytes and the Engine version: a change to either
   re-renders what it could affect, with no version number to remember to bump. *)
$RendererHash = If[StringQ[$InputFileName] && FileExistsQ[$InputFileName],
   FileHash[$InputFileName, "SHA256", All, "HexString"], "unknown"];
renderer[] := {$ExporterVersion, $RendererHash, $VersionNumber};
(* Mixed into every cache key; render-nb.wls --salt sets it to re-render without bumping the version. *)
$Salt = "";
$CacheDir = FileNameJoin[{$HomeDirectory, ".cache", "hafezi-notebooks"}];
$SD = "Default.nb";
$MaxSVG = 1.5*2^20;
$MaxAsset = 24*2^20;
$DownscaleAbove = 8*2^20;
$CellTimeLimit = 180;
$ManipulateBudget = 60;
$MaxFrames = 64;
$Stats = <||>;
$Log = {};

log[args___] := (AppendTo[$Log, StringJoin[ToString /@ {args}]]; Print[args]);

(* ---------- files and hashing ---------- *)

ensureDir[d_] := If[!DirectoryQ[d], CreateDirectory[d, CreateIntermediateDirectories -> True]];
cachePath[kind_, name_] := FileNameJoin[{$CacheDir, kind, name}];

atomicWrite[path_String, writer_] := Module[{tmp = path <> ".tmp" <> ToString[$KernelID] <> "-" <> ToString[RandomInteger[10^9]]},
  ensureDir[DirectoryName[path]];
  writer[tmp];
  RenameFile[tmp, path, OverwriteTarget -> True]];

writeBytes[path_, bytes_ByteArray] := atomicWrite[path, Function[tmp, Module[{s = OpenWrite[tmp, BinaryFormat -> True]}, BinaryWrite[s, bytes]; Close[s]]]];

WriteJSON[path_, expr_] := atomicWrite[path, Function[tmp,
  Module[{s = OpenWrite[tmp, BinaryFormat -> True]},
   BinaryWrite[s, ExportByteArray[expr /. {None -> Null, _Missing -> Null}, "RawJSON", "Compact" -> True]]; Close[s]]]];

readJSON[path_] := Quiet@Check[Import[path, "RawJSON"], $Failed];

sha[expr_] := Hash[expr, "SHA256", "HexString"];
fileSHA[file_] := FileHash[file, "SHA256", All, "HexString"];

(* ---------- cells ---------- *)

FlattenCells[cells_List] := Flatten[Replace[cells, {
     Cell[CellGroupData[inner_List, ___], ___] :> FlattenCells[inner]}, {1}]];

styleOf[Cell[_, s_String, ___]] := s;
styleOf[_] := None;

CellKind[style_String] := Replace[style, {
   "Title" -> "title",
   "Section" | "SectionInline" | "SectionNoDingbat" | "SectionDoubleDigit" -> "section",
   "Subsection" | "ResourcesSubsection" | "IndexSubsection" -> "h3",
   "Subsubsection" -> "h4",
   "VocabularySection" | "QASection" | "TechNoteSection" | "MoreExploreSection" -> "h2",
   "ExerciseSection" -> "exsection",
   "ExerciseSummaryCell" -> "exsummary",
   "AnswerKeyNumberedSection" -> "answersection",
   "Text" | "ResourcesText" | "ResourcesLink" | "ExerciseNote" | "VocabularyText" -> "p",
   "CodeCaption" -> "caption",
   "TechNote" -> "technote",
   "Question" -> "question",
   "Answer" -> "answer",
   "VocabularyTable" | "VocabularyTable3Column" -> "vocab",
   "MoreExplore" -> "more",
   "Exercise" -> "exercise",
   "ExerciseOutput" -> "expected",
   "Input" | "ExerciseInput" | "Code" -> "input",
   "Output" -> "output",
   "Print" | "Echo" | "Message" | "PrintTemporary" -> "aux",
   "Picture" -> "picture",
   "Index" | "IndexSubentry" | "IndexColumn" | "IndexLinkGuide" -> "index",
   "ExerciseExpectedResult" | "CodeSectionDividerCloud" | "Header" | "Footer" | "SectionNumber" |
     "AnswerKeySectionNumber" | "ExerciseNumber" | "KeyEvent" | "MenuName" | "InlineFormula" |
     "InlineCode" | "InlineCodeText" -> "skip",
   _ -> "p"}];

dingbatText[cell_] := Replace[FirstCase[cell, (CellDingbat -> d_) :> d, None],
  {Cell[s_String, ___] :> s, Cell[TextData[s_String, ___], ___] :> s, Cell[TextData[{s_String, ___}], ___] :> s, _ -> None}];

(* ---------- text ---------- *)

esc[s_String] := StringReplace[s, {"&" -> "&amp;", "<" -> "&lt;", ">" -> "&gt;", "\"" -> "&quot;"}];

(* Private-use characters the front end draws specially, as the closest Unicode. *)
$charMap = {
   "\[Rule]" -> "\[RightArrow]", "\[RuleDelayed]" -> "\:29f4", "\[Equal]" -> "==",
   "\[LongEqual]" -> "=", "\[Function]" -> "\:21a6", "\[TwoWayRule]" -> "\[LeftRightArrow]",
   "\[UndirectedEdge]" -> "\[LeftRightArrow]", "\[DirectedEdge]" -> "\[RightArrow]",
   "\[InvisibleSpace]" -> "", "\[InvisibleComma]" -> "", "\[InvisibleApplication]" -> "",
   "\[InvisibleTimes]" -> "", "\[AlignmentMarker]" -> "", "\[NoBreak]" -> "",
   "\[IndentingNewLine]" -> "\n", "\[Continuation]" -> "", "\[Transpose]" -> "\:1d40",
   "\[DifferentialD]" -> "d", "\[ExponentialE]" -> "e", "\[ImaginaryI]" -> "i",
   "\[ImaginaryJ]" -> "j", "\[LeftAssociation]" -> "<|", "\[RightAssociation]" -> "|>",
   "\[Placeholder]" -> "\:25a1", "\[SelectionPlaceholder]" -> "\:25a0", "\[Distributed]" -> "~",
   "\[FreeformPrompt]" -> "=", "\[NegativeThinSpace]" -> "", "\[NegativeMediumSpace]" -> "",
   "\[NegativeThickSpace]" -> "", "\[NegativeVeryThinSpace]" -> "", "\[SpaceIndicator]" -> "\:2423",
   "\[ReturnIndicator]" -> "\:21b5", "\[EscapeKey]" -> "esc", "\[AliasIndicator]" -> "\:22ee",
   "\[Conjugate]" -> "*", "\[HermitianConjugate]" -> "\:2020", "\[ConjugateTranspose]" -> "\:2020",
   "\[Piecewise]" -> "{", "\[CapitalDifferentialD]" -> "D", "\[DotlessJ]" -> "\:0237",
   "\[ThickSpace]" -> " ", "\[VeryThinSpace]" -> "\:200a", "\[MediumSpace]" -> "\:205f",
   "\[ThinSpace]" -> "\:2009", "\[LineSeparator]" -> "\n", "\[ParagraphSeparator]" -> "\n"};

puaQ[c_String] := With[{n = First@ToCharacterCode[c, "Unicode"]}, 57344 <= n <= 63743];
longName[c_String] := StringTrim[ToString[c, InputForm, CharacterEncoding -> "PrintableASCII"], "\""];

(* Text for display; unmapped private-use characters become their long names. *)
uni[s_String] := StringJoin[Replace[Characters[StringReplace[s, $charMap]],
    c_String?puaQ :> longName[c], {1}]];
(* Text for plain output: fails on unmapped private-use characters (render those as images). *)
uniStrict[s_String] := With[{t = StringReplace[s, $charMap]},
   If[AnyTrue[Characters[t], puaQ], $Failed, t]];

refURL[name_String] := "https://reference.wolfram.com/language/ref/" <> URLEncode[name] <> ".html";

(* A link to another notebook (ButtonData {"x.nb", tag}, NotebookLocate) becomes a {{nb:x.nb}}
   placeholder. Pages are made later (wolfram-pages.mjs), when every deployed notebook is known:
   a target that exists becomes a link to its page, one that doesn't (a name from the notebook's
   authoring system, say) stays plain text rather than a broken link. *)
pageURL[nb_String] := "{{nb:" <> nb <> "}}";

buttonHref[label_, opts_List] := Module[{style = BaseStyle /. opts /. BaseStyle -> None,
    data = ButtonData /. opts /. ButtonData -> None},
  Which[
   MatchQ[data, _String] && StringStartsQ[data, "paclet:ref/"], refURL[StringDrop[data, 11]],
   MatchQ[data, _String] && StringStartsQ[data, "paclet:"], "https://reference.wolfram.com/language/" <> StringDrop[data, 7],
   MatchQ[data, {URL[_String], ___}], data[[1, 1]],
   MatchQ[data, URL[_String]], data[[1]],
   MatchQ[data, {_String, ___}] && StringEndsQ[data[[1]], ".nb"], pageURL[data[[1]]],
   locatedNotebook[opts] =!= None, pageURL[locatedNotebook[opts]],
   MatchQ[style, "Link" | "CodeLink" | "InlineCodeLink" | "RefLink" | "ExampleLink"],
   If[StringQ[data], refURL[data], With[{t = BoxText[label, False]}, If[StringQ[t], refURL[StringTrim@t], None]]],
   True, None]];

(* Buttons that run front end actions (open/close groups, expected output toggles) carry no content. *)
actionButtonQ[opts_List] := !FreeQ[opts, ButtonFunction] && FreeQ[opts, ButtonData] && locatedNotebook[opts] === None;
(* Index-style entries link with ButtonFunction :> NotebookLocate[{"other.nb", tag}]. *)
locatedNotebook[opts_List] := FirstCase[opts, NotebookLocate[{f_String /; StringEndsQ[f, ".nb"], ___}, ___] :> f, None, Infinity];

textHTML[s_String] := esc[uni[s]];
textHTML[TextData[x_]] := textHTML[x];
textHTML[BoxData[b_]] := inlineCodeHTML[b];
textHTML[l_List] := StringJoin[textHTML /@ l];
textHTML[StyleBox[x_, rest___]] := Module[{opts = {rest}, inner = textHTML[x], styles},
   styles = Cases[opts, _String];
   inner = Which[
     MemberQ[opts, FontSlant -> "Italic" | Italic] || MemberQ[styles, "TI" | "Italic" | "TR"], "<em>" <> inner <> "</em>",
     MemberQ[opts, FontWeight -> "Bold" | Bold] || MemberQ[styles, "Bold" | "TB"], "<strong>" <> inner <> "</strong>",
     MemberQ[styles, "InlineCode" | "InlineCodeText" | "Input" | "MR" | "InlineCodeLink"], "<code class=\"wl-inline\">" <> inner <> "</code>",
     True, inner];
   inner];
textHTML[ButtonBox[label_, opts___]] := Module[{href},
   If[actionButtonQ[{opts}], Return[""]];
   href = buttonHref[label, {opts}];
   If[href === None, textHTML[label],
    "<a class=\"" <> If[StringStartsQ[href, "/" | "./" | "{{nb:"], "internal", "external wl-ref"] <> "\" href=\"" <> esc[href] <> "\">" <> textHTML[label] <> "</a>"]];
textHTML[Cell[BoxData[b_], rest___]] := inlineCell[b, {rest}];
textHTML[Cell[TextData[x_], ___]] := textHTML[x];
textHTML[Cell[s_String, ___]] := textHTML[s];
textHTML[Cell[b_, ___]] := textHTML[b];
textHTML[RowBox[l_List]] := textHTML[l];
textHTML[(TagBox | InterpretationBox | FormBox | AdjustmentBox | TooltipBox | PaneBox | FrameBox | ItemBox)[x_, ___]] := textHTML[x];
textHTML[TemplateBox[{keys__String}, t_String /; StringMatchQ[t, "Key" ~~ ___]]] :=
  StringRiffle["<kbd>" <> esc[uni[#]] <> "</kbd>" & /@ {keys}, "+"];
textHTML[CounterBox[___]] := "";
textHTML[b_] := inlineCodeHTML[b];

(* An inline cell: code (linearized, with reference links) or, failing that, a picture. *)
inlineCell[b_, opts_] := Module[{t = codeHTML[b]},
   If[StringQ[t], "<code class=\"wl-inline\">" <> t <> "</code>",
    inlineImage[b, If[MemberQ[opts, _String], First@Cases[opts, _String], "InlineCode"]]]];

inlineCodeHTML[b_] := Module[{t = codeHTML[b]},
   If[StringQ[t], "<code class=\"wl-inline\">" <> t <> "</code>", inlineImage[b, "InlineCode"]]];

inlineImage[b_, style_] := Module[{a = renderBoxes[b, style, "svg"]},
   If[!AssociationQ[a], "",
    "<img class=\"wl-inline-img\" src=\"{{asset:" <> a["sha"] <> "." <> a["ext"] <> "}}\" width=\"" <>
     ToString[a["width"]] <> "\" height=\"" <> ToString[a["height"]] <> "\" alt=\"\">"]];

(* Box linearization. *)
unquote[s_String] := If[StringLength[s] >= 2 && StringStartsQ[s, "\""] && StringEndsQ[s, "\""],
   StringReplace[StringTake[s, {2, -2}], {"\\\"" -> "\"", "\\\\" -> "\\", "\\n" -> "\n", "\\t" -> "\t"}], s];

Options[boxLinear] = {"Quotes" -> True, "HTML" -> False};
boxLinear[b_, OptionsPattern[]] := Catch[lin[b, OptionValue["Quotes"], OptionValue["HTML"]], $tag];
fail[] := Throw[$Failed, $tag];
wrapTag[h_, tag_, s_] := If[h, "<" <> tag <> ">" <> s <> "</" <> tag <> ">", s];

lin[s_String, q_, h_] := Module[{t = uniStrict[If[q, s, unquote[s]]]},
   If[t === $Failed, fail[]];
   If[TrueQ[$digitBlocks] && StringMatchQ[s, DigitCharacter ~~ DigitCharacter ~~ DigitCharacter ~~ DigitCharacter ~~ DigitCharacter ..], t = digitBlock[t]];
   If[h, esc[t], t]];
(* Output cells show long integers in blocks of three (7\[ThinSpace]006\[ThinSpace]652). *)
$digitBlocks = False;
digitBlock[t_String] := StringRiffle[Reverse[StringReverse /@ StringPartition[StringReverse[t], UpTo[3]]], "\:2009"];
(* The front end sets list commas as ", "; so does the linear text. *)
lin[RowBox[l_List], q_, h_] := StringJoin[MapIndexed[
    With[{t = lin[#1, q, h], next = If[#2[[1]] < Length[l], l[[#2[[1]] + 1]], None]},
      If[#1 === "," && !(StringQ[next] && StringStartsQ[next, WhitespaceCharacter]), t <> " ", t]] &, l]];
lin[StyleBox[x_, rest___], q_, h_] := Module[{opts = {rest}, qq = q},
   If[MemberQ[opts, ShowStringCharacters -> False], qq = False];
   If[MemberQ[opts, ShowStringCharacters -> True], qq = True];
   lin[x, qq, h]];
lin[(TagBox | FormBox | AdjustmentBox | TooltipBox | ItemBox)[x_, ___], q_, h_] := lin[x, q, h];
lin[InterpretationBox[x_, ___], q_, h_] := lin[x, q, h];
lin[ButtonBox[x_, opts___], q_, h_] := Module[{inner = lin[x, q, h], href},
   If[!h, Return[inner]];
   href = buttonHref[x, {opts}];
   If[href === None || actionButtonQ[{opts}], inner, "<a class=\"wl-ref\" href=\"" <> esc[href] <> "\">" <> inner <> "</a>"]];
lin[SuperscriptBox[a_, b_], q_, h_] := lin[a, q, h] <> If[h, "<sup>" <> lin[b, q, h] <> "</sup>", "^" <> paren[lin[b, q, h]]];
lin[SubscriptBox[a_, b_], q_, h_] := lin[a, q, h] <> If[h, "<sub>" <> lin[b, q, h] <> "</sub>", "_" <> paren[lin[b, q, h]]];
lin[FractionBox[a_, b_], q_, h_] := paren[lin[a, q, h]] <> "/" <> paren[lin[b, q, h]];
lin[SqrtBox[a_], q_, h_] := "\:221a" <> paren[lin[a, q, h]];
lin[TemplateBox[args_List, "RowDefault", ___], q_, h_] := StringJoin[lin[#, q, h] & /@ args];
lin[TemplateBox[{sep_, args___}, "RowWithSeparator" | "RowWithSeparators", ___], q_, h_] :=
  StringRiffle[lin[#, q, h] & /@ {args}, lin[sep, q, h]];
lin[TemplateBox[_, "Spacer1" | "Spacer2", ___], _, _] := " ";
lin[TemplateBox[{keys__String}, t_String /; StringMatchQ[t, "Key" ~~ ___], ___], _, h_] :=
  If[h, StringRiffle["<kbd>" <> esc[#] <> "</kbd>" & /@ {keys}, "+"], StringRiffle[{keys}, "+"]];
lin[_, _, _] := fail[];
paren[s_String] := If[StringMatchQ[s, (WordCharacter | ".") ..], s, "(" <> s <> ")"];

BoxText[b_, quotes_: False] := boxLinear[b, "Quotes" -> quotes];
codeHTML[b_] := boxLinear[b, "Quotes" -> True, "HTML" -> True];

(* ---------- input code ---------- *)

(* A Graph typed into an input (a picture in the cell) comes out of InputText as linear syntax
   around its compressed box data; write it as the Graph expression it holds instead, so the code
   reads, edits and runs as code. *)
graphCode[g_Graph] := ToString[g, InputForm];
graphCode[_] := $Failed;
readableGraphs[b_] := b /. gb : GraphicsBox[NamespaceBox["NetworkGraphics", dm_DynamicModuleBox, ___], ___] :>
    With[{code = graphCode[FirstCase[dm, HoldPattern[Set[s_Symbol, HoldComplete[g_]]] /;
           SymbolName[Unevaluated[s]] === "graph" :> Quiet@Check[ReleaseHold[HoldComplete[g]], $Failed], $Failed, Infinity]]},
     If[StringQ[code], code, gb]];

InputCode[b_] := Module[{t},
   t = Quiet@Check[First@FrontEndExecute[ExportPacket[Cell[BoxData[readableGraphs[b]], "Input"], "InputText"]], $Failed];
   If[!StringQ[t], Return[$Failed]];
   (* Named characters that are ordinary Unicode read better as themselves; both parse. *)
   StringReplace[t, "\\[" ~~ name : WordCharacter .. ~~ "]" :> With[{c = Quiet@ToExpression["\"\\[" <> name <> "]\""]},
      If[StringQ[c] && StringLength[c] == 1 && !puaQ[c] && First@ToCharacterCode[c] > 127, c, "\\[" <> name <> "]"]]]];

$defHeads = Set | SetDelayed | TagSet | TagSetDelayed | UpSet | UpSetDelayed | SetAttributes |
   SetOptions | Needs | Get | Unset | Clear | ClearAll | AddTo | SubtractFrom | AppendTo |
   PrependTo | Increment | Decrement | PreIncrement | PreDecrement | TimesBy | DivideBy;
DefinitionQ[code_String] := Module[{h = Quiet@Check[ToExpression[code, InputForm, HoldComplete], $Failed]},
   If[h === $Failed, False,
    h = h /. HoldComplete[CompoundExpression[a___]] :> HoldComplete[a];
    Length[Cases[h, $defHeads[___], {1}, Heads -> False]] > 0]];

(* Free-form (ctrl+=) input keeps the parsed boxes it resolved to; use those as the code. *)
resolveLinguistic[b_] := b /. NamespaceBox["LinguisticAssistant", dm_, ___] :>
    With[{x = FirstCase[dm, HoldPattern[Set[s_Symbol, y_]] /; SymbolName[Unevaluated[s]] === "boxes$$" :> y, "None", Infinity]},
     If[StringQ[x] && StringMatchQ[x, "\"None\"" | "None"],
      (* Never resolved in the saved notebook: interpret the query when run. *)
      With[{q = FirstCase[dm, HoldPattern[Set[s_Symbol, y_String]] /; SymbolName[Unevaluated[s]] === "query$$" :> y, "", Infinity]},
       If[StringTrim[q] === "", NamespaceBox["LinguisticAssistant", dm],
        RowBox[{"SemanticInterpretation", "[", ToString[q, InputForm], "]"}]]],
      x]];

placeholderInputQ[b_] := !FreeQ[b, "Click"] && !FreeQ[b, ButtonBox];
graphicalQ[b_] := !FreeQ[b, GraphicsBox | Graphics3DBox | RasterBox | DynamicModuleBox];

(* ---------- rendering ---------- *)

cellFor[b_, style_] := Cell[BoxData[b], style, CellMargins -> {{0, 0}, {0, 0}}, ShowCellLabel -> False,
   CellDingbat -> None, CellFrame -> 0, CellFrameLabels -> None, ShowCellBracket -> False,
   CellFrameMargins -> 0, Background -> White];
nbFor[b_, style_] := Notebook[{cellFor[b, style]}, StyleDefinitions -> $SD, Background -> White,
   PrintingStyleEnvironment -> "Working", ScreenStyleEnvironment -> "Working"];

svgSize[bytes_ByteArray] := Module[{head = ByteArrayToString[Take[bytes, UpTo[800]]], w, h},
   w = StringCases[head, "width=\"" ~~ x : NumberString ~~ "pt\"" :> ToExpression[x], 1];
   h = StringCases[head, "height=\"" ~~ x : NumberString ~~ "pt\"" :> ToExpression[x], 1];
   If[w === {} || h === {}, {0, 0}, Round[{First@w, First@h}]]];
pngSize[bytes_ByteArray] := {FromDigits[Normal@bytes[[17 ;; 20]], 256], FromDigits[Normal@bytes[[21 ;; 24]], 256]};

(* ---------- the same notebook renders to the same bytes ----------
   The front end stamps its renders: PNGs carry eXIf/tEXt/tIME creation metadata (the pixels are
   identical run to run), cairo numbers SVG surfaces with a session-wide counter, and every Ogg
   stream gets a random serial number. NormalizeAsset removes exactly that, so a notebook renders to
   identical bytes on every run (tools/notebooks/prove.sh renders twice and compares). *)
NormalizeAsset[bytes_ByteArray, "png"] := pngStrip[bytes];
NormalizeAsset[bytes_ByteArray, "svg"] := svgIds[bytes];
NormalizeAsset[bytes_ByteArray, "ogg"] := oggSerial[bytes];
NormalizeAsset[bytes_ByteArray, _] := bytes;

$pngSignature = {137, 80, 78, 71, 13, 10, 26, 10};
$pngDropChunks = {"eXIf", "tEXt", "zTXt", "iTXt", "tIME"};
pngStrip[b_ByteArray] := Module[{p = 9, n = Length[b], keep = {1 ;; 8}, len, type},
   If[n < 8 || Normal[b[[1 ;; 8]]] =!= $pngSignature, Return[b]];
   While[p + 7 <= n,
    len = FromDigits[Normal[b[[p ;; p + 3]]], 256];
    type = FromCharacterCode[Normal[b[[p + 4 ;; p + 7]]]];
    If[p + 11 + len > n, Return[b]];
    If[!MemberQ[$pngDropChunks, type], AppendTo[keep, p ;; p + 11 + len]];
    p += 12 + len];
   Join @@ (b[[#]] & /@ keep)];

(* Every id, renumbered in order of first appearance, with every #reference to it. *)
svgIds[b_ByteArray] := Module[{t = ByteArrayToString[b, "UTF-8"], ids, map},
   ids = DeleteDuplicates@StringCases[t, " id=\"" ~~ x : Except["\""] .. ~~ "\"" :> x];
   If[ids === {}, Return[b]];
   map = AssociationThread[ids, "n" <> ToString[#] & /@ Range[Length[ids]]];
   StringToByteArray[StringReplace[t, {
      " id=\"" ~~ x : Except["\""] .. ~~ "\"" :> " id=\"" <> Lookup[map, x, x] <> "\"",
      "#" ~~ x : Except["\"" | "'" | ")" | " "] .. ~~ end : ("\"" | "'" | ")") /; KeyExistsQ[map, x] :> "#" <> map[x] <> end}],
    "UTF-8"]];

(* Ogg: a fixed stream serial number ("HFZ1") and each page's CRC recomputed for it. *)
$oggCRCTable = Table[Module[{r = BitShiftLeft[i, 24]},
     Do[r = If[BitAnd[r, 16^^80000000] != 0, BitXor[BitAnd[BitShiftLeft[r, 1], 16^^FFFFFFFF], 16^^04C11DB7],
        BitAnd[BitShiftLeft[r, 1], 16^^FFFFFFFF]], 8]; r], {i, 0, 255}];
oggCRC[bytes_List] := Fold[BitXor[BitAnd[BitShiftLeft[#1, 8], 16^^FFFFFFFF], $oggCRCTable[[BitXor[BitShiftRight[#1, 24], #2] + 1]]] &, 0, bytes];
oggSerial[b_ByteArray] := Module[{l = Normal[b], p = 1, n = Length[b], segs, len, page},
   If[n < 27 || l[[1 ;; 4]] =!= ToCharacterCode["OggS"], Return[b]];
   While[p + 26 <= n && l[[p ;; p + 3]] === ToCharacterCode["OggS"],
    segs = l[[p + 26]];
    len = 27 + segs + Total[l[[p + 27 ;; p + 26 + segs]]];
    If[p + len - 1 > n, Return[b]];
    l[[p + 14 ;; p + 17]] = ToCharacterCode["HFZ1"];
    l[[p + 22 ;; p + 25]] = {0, 0, 0, 0};
    l[[p + 22 ;; p + 25]] = Reverse@IntegerDigits[oggCRC[l[[p ;; p + len - 1]]], 256, 4];
    p += len];
   ByteArray[l]];

(* Store an asset; returns <|sha, ext, bytes, width, height|> (CSS pixel size). The bytes are
   normalized first, so the name (a hash) depends only on what was rendered. *)
putAsset[raw_ByteArray, ext_String, {w_, h_}, extra_: <||>] := Module[{bytes = NormalizeAsset[raw, ext], hash},
   hash = sha[bytes];
   With[{path = cachePath["assets", hash <> "." <> ext]}, If[!FileExistsQ[path], writeBytes[path, bytes]]];
   Join[<|"sha" -> hash, "ext" -> ext, "bytes" -> Length[bytes], "width" -> w, "height" -> h|>, extra]];

pngAsset[nb_, res_: 144] := Module[{bytes = Quiet@Check[ExportByteArray[nb, "PNG", ImageResolution -> res], $Failed], size, r = res},
   If[!ByteArrayQ[bytes], Return[$Failed]];
   While[Length[bytes] > $DownscaleAbove && r > 36,
    r = Round[r/2]; bytes = ExportByteArray[nb, "PNG", ImageResolution -> r]];
   If[Length[bytes] > $MaxAsset, Return[$Failed]];
   size = pngSize[bytes];
   putAsset[bytes, "png", Round[size*72/r]]];

svgAsset[nb_] := Module[{bytes = Quiet@Check[ExportByteArray[nb, "SVG"], $Failed]},
   If[!ByteArrayQ[bytes] || Length[bytes] > $MaxSVG, Return[pngAsset[nb]]];
   putAsset[bytes, "svg", svgSize[bytes]]];

(* Shown at the size the notebook shows it: a 720 px image at 144 dpi is 360 points across. *)
imageResolution[img_Image] := Replace[Quiet[ImageResolution /. Options[img, ImageResolution]],
   {{r_?Positive, ___} :> r, r_?Positive :> r, _ -> 72}];
imageAsset[img_Image] := Module[{bytes = ExportByteArray[img, "PNG"], i = img},
   While[Length[bytes] > $DownscaleAbove, i = ImageResize[i, Scaled[1/2]]; bytes = ExportByteArray[i, "PNG"]];
   putAsset[bytes, "png", Round[ImageDimensions[img]*72/imageResolution[img]]]];

(* Per-box cache: identical boxes render once across every notebook. Rendering can evaluate the
   box's dynamic content (a Manipulate snapshot calling RandomColor, say), in the kernel or in the
   front end's own sandboxed kernel, so the random generator is seeded from the box itself in both:
   around the render here, and as the first step of a DynamicModule's Initialization. Only a module
   the front end initializes synchronously in the kernel (a Manipulate's) can take that first step:
   given an Initialization, any other module (a Graph's NetworkGraphics, with
   AllowKernelInitialization -> False; a PieChart's click state; Iconize; summary boxes) was drawn
   uninitialized, as an empty white box. *)
(* By name: AllowKernelInitialization is not a System` symbol, so a notebook's is not this file's. *)
seedableQ[opts_List] := MemberQ[opts, SynchronousInitialization -> True] &&
   FreeQ[opts, (s_Symbol -> False) /; SymbolName[Unevaluated[s]] === "AllowKernelInitialization"];
seedDynamics[b_, seed_Integer] := b /. DynamicModuleBox[vars_, body_, opts___] /; seedableQ[{opts}] :>
    With[{init = Cases[{opts}, (Initialization :> i_) :> Hold[i]], rest = Sequence @@ DeleteCases[{opts}, Initialization :> _]},
     If[init === {},
      DynamicModuleBox[vars, body, Initialization :> SeedRandom[seed], rest],
      With[{i = First[init]}, DynamicModuleBox[vars, body, Initialization :> (SeedRandom[seed]; ReleaseHold[i]), rest]]]];
renderBoxes[b_, style_, format_] := Module[{key = sha[{b, style, format, $SDHash, renderer[], $Salt}], path, r},
   path = cachePath["boxes", key <> ".json"];
   If[FileExistsQ[path] && AssociationQ[r = readJSON[path]] && FileExistsQ[cachePath["assets", r["sha"] <> "." <> r["ext"]]], Return[r]];
   r = With[{seed = FromDigits[StringTake[key, 15], 16]}, With[{nb = nbFor[seedDynamics[b, seed], style]},
      BlockRandom[SeedRandom[seed]; Switch[format, "svg", svgAsset[nb], "png", pngAsset[nb], "png3d", pngAsset[nb, 144]]]]];
   If[AssociationQ[r], WriteJSON[path, r]];
   r];

imageBoxQ[b_] := MatchQ[b, GraphicsBox[TagBox[_RasterBox, _BoxForm`ImageTag, ___], ___]];

OutputKind[b_] := Which[
   !FreeQ[b, Manipulate`InterpretManipulate], "manipulate",
   !FreeQ[b, TemplateBox[_, "VideoBox2", ___]], "video",
   !FreeQ[b, Audio`AudioBox] || MatchQ[b, InterpretationBox[_, _Sound, ___]], "audio",
   imageBoxQ[b], "image",
   !FreeQ[b, Graphics3DBox], "graphics3d",
   StringQ[BoxText[b]], "text",
   gridRows[b] =!= $Failed, "table",
   True, "typeset"];

gridRows[b_] := Module[{g = b /. TagBox[x_GridBox, "Grid" | "Column" | _, ___] :> x},
   If[!MatchQ[g, GridBox[{__List}, ___]], Return[$Failed]];
   Catch[Map[With[{t = boxLinear[#, "Quotes" -> False, "HTML" -> True]}, If[StringQ[t], t, Throw[$Failed]]] &, First[g], {2}]]];

renderOutput[b_, style_] := Module[{kind = OutputKind[b]},
   Switch[kind,
    "text", <|"kind" -> "text", "text" -> Block[{$digitBlocks = True}, BoxText[b]]|>,
    "table", <|"kind" -> "table", "rows" -> Block[{$digitBlocks = True}, gridRows[b]]|>,
    "image", Module[{img = Quiet@Check[ToExpression[b], $Failed]},
     If[ImageQ[img], <|"kind" -> "image", "asset" -> imageAsset[img]|>, <|"kind" -> "image", "asset" -> renderBoxes[b, style, "png"]|>]],
    "graphics3d", <|"kind" -> "image", "asset" -> renderBoxes[b, style, "png3d"]|>,
    "audio", renderAudio[b, style],
    "video", renderVideo[b, style],
    "manipulate", renderManipulate[b, style],
    _, <|"kind" -> "image", "asset" -> renderBoxes[b, style, "svg"]|>]];

renderAudio[b_, style_] := Module[{a, ogg, mp3},
   a = Quiet@Check[ToExpression[b], $Failed];
   If[!MatchQ[Head[a], Audio | Sound], a = FirstCase[b, HoldPattern[Audio`AudioObjects`audio$$ = HoldComplete[x_]] :> x, $Failed, Infinity]];
   If[!MatchQ[Head[a], Audio | Sound], Return[<|"kind" -> "image", "asset" -> renderBoxes[b, style, "svg"]|>]];
   ogg = Quiet@Check[ExportByteArray[a, "OGG"], $Failed];
   mp3 = Quiet@Check[ExportByteArray[a, "MP3"], $Failed];
   <|"kind" -> "audio",
    "ogg" -> If[ByteArrayQ[ogg], putAsset[ogg, "ogg", {0, 0}], Null],
    "mp3" -> If[ByteArrayQ[mp3], putAsset[mp3, "mp3", {0, 0}], Null],
    "snapshot" -> renderBoxes[b, style, "png"]|>];

renderVideo[b_, style_] := Module[{args = FirstCase[b, TemplateBox[a_Association | {a_Association, ___}, "VideoBox2", ___] :> a, <||>, {0, Infinity}], frame, img, href},
   frame = Lookup[args, "cachedFrame", None];
   img = If[ByteArrayQ[frame], Quiet@Check[ImportByteArray[frame], $Failed], $Failed];
   href = Replace[Lookup[args, "resourcePath", None], {CloudObject[u_String, ___] :> u, File[f_String] :> None, u_String :> u, _ -> None}];
   <|"kind" -> "video",
    "thumb" -> If[ImageQ[img], imageAsset[img], renderBoxes[b, style, "png"]],
    "href" -> href,
    "duration" -> Lookup[Lookup[args, "properties", <||>], "duration", Null]|>];

(* ---------- Manipulate ---------- *)

$nondeterministic = Alternatives @@ Join[
    Select[Names["System`Random*"], !StringContainsQ[#, "`"] &],
    {"Now", "Today", "Clock", "CurrentImage", "Dynamic", "Refresh", "AbsoluteTime", "SessionTime",
     "DateList", "CurrentDate", "Unique", "Pause", "URLFetch", "URLRead", "Import", "Interpreter",
     "EntityValue", "WolframAlpha", "SemanticInterpretation", "ImageIdentify", "Classify", "Predict"}];
deterministicQ[held_] := FreeQ[held, s_Symbol /; StringMatchQ[SymbolName[Unevaluated[s]], $nondeterministic], Heads -> True];

varLabel[v_Symbol] := StringReplace[SymbolName[Unevaluated[v]], "$$" ~~ EndOfString -> ""];
SetAttributes[varLabel, HoldFirst];
heldLabel = Function[x, valueLabel[x], HoldFirst];
$namedColors := $namedColors = Association[Table[ToExpression[n] -> n, {n, {"Red", "Green", "Blue", "Black", "White", "Gray", "Cyan",
      "Magenta", "Yellow", "Brown", "Orange", "Pink", "Purple", "LightRed", "LightGreen", "LightBlue", "LightGray",
      "LightCyan", "LightMagenta", "LightYellow", "LightBrown", "LightOrange", "LightPink", "LightPurple", "Darker[Red]"}}]];
valueLabel[x_] := Which[
   KeyExistsQ[$namedColors, x], $namedColors[x],
   ColorQ[x], "color",
   IntegerQ[x], ToString[x],
   Internal`RealValuedNumericQ[x] && x == Round[x], ToString[Round[x]],
   NumericQ[x], ToString[NumberForm[N[x], 3]],
   StringQ[x], x,
   True, StringReplace[ToString[x, InputForm], {"$CellContext`" -> "", "$$" -> ""}]];

(* One control per spec: <|var, label, values, labels, continuous|> or $Failed when unsupported. *)
controlOf[spec_Hold] := Replace[spec, {
    Hold[{{v_Symbol, init_, label_String, ___}, rest___}] :> With[{c = controlOf[Hold[{v, rest}]]}, If[AssociationQ[c], Append[c, "label" -> label], c]],
    Hold[{{v_Symbol, init_, ___}, rest___}] :> controlOf[Hold[{v, rest}]],
    Hold[{v_Symbol, min_?NumericQ, max_?NumericQ, step_?NumericQ, ___}] :> With[{vals = Range[min, max, step]},
      If[Length[vals] > $MaxFrames, $Failed,
       <|"var" -> Hold[v], "label" -> varLabel[v], "values" -> vals, "labels" -> (valueLabel /@ vals), "continuous" -> False|>]],
    Hold[{v_Symbol, min_?NumericQ, max_?NumericQ, ___}] :>
     <|"var" -> Hold[v], "label" -> varLabel[v], "min" -> min, "max" -> max, "continuous" -> True|>,
    Hold[{v_Symbol, l_List, ___}] :> With[{labels = List @@ (heldLabel /@ Hold @@ Unevaluated[l])},
      If[Length[l] > $MaxFrames, $Failed,
       <|"var" -> Hold[v], "label" -> varLabel[v], "values" -> l, "labels" -> labels, "continuous" -> False|>]],
    _ -> $Failed}];

sampleControls[controls_] := Module[{fixed = Times @@ (Length[#["values"]] & /@ Select[controls, !#["continuous"] &]),
    nc = Count[controls, _?(#["continuous"] &)], k},
   If[fixed > $MaxFrames, Return[$Failed]];
   k = If[nc == 0, 1, Min[16, Floor[($MaxFrames/fixed)^(1/nc)]]];
   If[nc > 0 && k < 3, Return[$Failed]];
   Map[If[#["continuous"], With[{vals = N@Subdivide[#["min"], #["max"], k - 1]},
       Join[#, <|"values" -> vals, "labels" -> (valueLabel /@ vals)|>]], #] &, controls]];

renderManipulate[b_, style_] := Module[{snap = renderBoxes[b, style, "png"], body, specs, controls, frames, t0 = AbsoluteTime[], tuples, ok = True, res},
   res = <|"kind" -> "manipulate", "snapshot" -> snap, "frames" -> {}, "controls" -> {}|>;
   body = FirstCase[b, (Rule | RuleDelayed)[s_, x_] /; ToString[Unevaluated[s]] === "Body" :> Hold[x], None, Infinity];
   specs = FirstCase[b, (Rule | RuleDelayed)[s_, x_] /; ToString[Unevaluated[s]] === "Specifications" :> Hold[x], None, Infinity];
   If[body === None || specs === None || !deterministicQ[body], Return[Append[res, "reason" -> "not deterministic"]]];
   controls = controlOf /@ Replace[specs, Hold[l_List] :> (Hold /@ Unevaluated[l])];
   controls = If[ListQ[controls], controls, List @@ controls];
   If[!AllTrue[controls, AssociationQ] || controls === {}, Return[Append[res, "reason" -> "unsupported controls"]]];
   controls = sampleControls[controls];
   If[controls === $Failed, Return[Append[res, "reason" -> "too many frames"]]];
   tuples = Tuples[Range[Length[#["values"]]] & /@ controls];
   frames = Reap[Do[
       If[AbsoluteTime[] - t0 > $ManipulateBudget, ok = False; Break[]];
       Module[{rules = MapThread[#1["var"] /. Hold[v_] :> (HoldPattern[v] -> #1["values"][[#2]]) &, {controls, tuple}], expr, r},
        expr = Quiet@Check[TimeConstrained[ReleaseHold[body /. rules], 10, $Failed], $Failed];
        r = If[expr === $Failed, $Failed, pngAsset[nbFor[ToBoxes[expr, StandardForm], style]]];
        If[!AssociationQ[r], ok = False; Break[]];
        Sow[r]],
       {tuple, tuples}]][[2]];
   frames = If[frames === {}, {}, First[frames]];
   If[!ok || Length[frames] != Length[tuples], Return[Append[res, "reason" -> "frame rendering failed or exceeded budget"]]];
   Join[res, <|"frames" -> frames,
     "controls" -> (<|"name" -> #["label"], "label" -> #["label"], "values" -> #["labels"]|> & /@ controls)|>]];

(* ---------- cells to blocks ---------- *)

cellContent[Cell[c_, ___]] := c;

cellKey[cell_] := sha[{cell, $SDHash, renderer[], $Salt}];

(* Render one cell to a block association, through the per-cell cache. *)
renderCell[cell_, ctx_] := Module[{key = cellKey[{cell, ctx}], path, r},
   path = cachePath["cells", key <> ".json"];
   $Stats["cells"]++;
   If[FileExistsQ[path] && AssociationQ[r = readJSON[path]], $Stats["cached"]++; Return[r]];
   (* Messages alone are not failures (the front end and importers are chatty); a cell fails when
      it produced no block or a part of it failed to render. *)
   With[{ev = EvaluationData[Quiet@TimeConstrained[renderCellUncached[cell, ctx], $CellTimeLimit, $TimedOut]]},
    r = ev["Result"];
    If[!AssociationQ[r] || !FreeQ[r, $Failed | $Aborted | $TimedOut | _Missing],
     r = <|"t" -> "error", "message" -> StringRiffle[Join[
          {If[r === $TimedOut, "timed out", "render failed"]},
          Take[DeleteDuplicates[ev["MessagesText"]], UpTo[3]]], "; "]|>]];
   If[r["t"] === "error", $Stats["failed"] = Append[$Stats["failed"], <|"style" -> styleOf[cell], "message" -> r["message"]|>]; log["  cell failed: ", styleOf[cell], ": ", r["message"]],
    WriteJSON[path, r]];
   $Stats["exported"]++;
   r];

renderCellUncached[cell_, ctx_] := Module[{style = styleOf[cell], kind, c = cellContent[cell]},
   kind = CellKind[style];
   Switch[kind,
    "input", Module[{b = Replace[c, BoxData[x_] :> x], code, r},
      (* Authoring leftovers: metadata rules, private symbols, expected-output notes. *)
      If[MatchQ[c, BoxData[_Rule | _RuleDelayed]] || !FreeQ[c, "ExpectedOutputNote"] ||
        (StringQ[c] && StringContainsQ[c, "`Private`"]), Return[<|"t" -> "skip"|>]];
      If[placeholderInputQ[b], Return[<|"t" -> "skip"|>]];
      (* Some examples are stored as raw input strings rather than boxes. *)
      code = Which[StringQ[c], StringTrim[c], MatchQ[c, _BoxData], InputCode[resolveLinguistic[b]], True, $Failed];
      If[!StringQ[code], Return[<|"t" -> "error", "message" -> "InputText export failed"|>]];
      r = <|"t" -> "input", "code" -> code, "def" -> DefinitionQ[code], "label" -> dingbatText[cell]|>;
      (* Pictures and free-form input show as the book draws them; the code stays runnable. *)
      If[!StringQ[c] && (graphicalQ[b] || !FreeQ[b, NamespaceBox]),
       r["display"] = renderBoxes[b, style, "svg"];
       If[StringLength[code] > 65536 || StringContainsQ[code, "LinguisticAssistant"], r["norun"] = True; r["code"] = If[StringLength[code] > 65536, "", code]]];
      r],
    "output" | "aux" | "picture", <|"t" -> "output", "style" -> style, "out" -> renderOutput[Replace[c, {BoxData[x_] :> x, t_TextData :> Cell[t]}], "Output"]|>,
    "expected", Module[{x = FirstCase[c, InterpretationBox[Cell[BoxData[y_], "ExerciseOutput", ___], ___] :> y, None, Infinity]},
      If[x === None, x = Replace[c, BoxData[y_] :> y]];
      <|"t" -> "expected", "out" -> renderOutput[x, "ExerciseOutput"]|>],
    "vocab", Module[{rows = FirstCase[c, GridBox[r_List, ___] :> r, {}, Infinity]},
      <|"t" -> "vocab", "rows" -> Map[vocabCell, DeleteCases[#, " " | "\[ThickSpace]"] & /@ rows, {2}]|>],
    "exsummary", <|"t" -> "exsummary", "text" -> First[StringCases[ToString[c, InputForm], n : DigitCharacter .. ~~ " Exercises" :> n], ""]|>,
    "exsection", <|"t" -> "h2", "html" -> "Exercises", "cls" -> "wl-exsection"|>,
    "answersection", <|"t" -> "h2", "html" -> Replace[dingbatText[cell], {None -> "", n_ :> esc[StringTrim[StringReplace[n, "|" -> ""]]] <> ". "}] <> textHTML[c]|>,
    "exercise", <|"t" -> "exercise", "num" -> dingbatText[cell], "html" -> textHTML[c]|>,
    "skip", <|"t" -> "skip"|>,
    "section" | "title", <|"t" -> "section", "html" -> sectionText[c]|>,
    "h2" | "h3" | "h4", If[dynamicOnlyQ[c], <|"t" -> "skip"|>, <|"t" -> kind, "html" -> textHTML[c], "cls" -> "wl-" <> ToLowerCase[style]|>],
    "index", With[{entries = Cases[c, Cell[x_, s : "Index" | "IndexSubentry", ___] :> {s, x}, Infinity]},
      If[style === "IndexColumn" && entries =!= {},
       (* A column of the book index: a grid of entry cells becomes a list. *)
       <|"t" -> "list", "cls" -> "wl-index-list", "html" -> StringJoin[
          "<li" <> If[#[[1]] === "IndexSubentry", " class=\"wl-index-sub\"", ""] <> ">" <> textHTML[#[[2]]] <> "</li>" & /@ entries]|>,
       <|"t" -> "index", "style" -> style, "html" -> textHTML[c]|>]],
    _, Which[
     dynamicOnlyQ[c], <|"t" -> "skip"|>,
     MatchQ[c, BoxData[_]] && graphicalQ[c], <|"t" -> "output", "style" -> style, "out" -> renderOutput[First[c], style]|>,
     True, <|"t" -> kind, "html" -> textHTML[c]|>]]];

(* Front end widgets (solution checkers, counters) that have no static content. *)
dynamicOnlyQ[c_] := MatchQ[c, BoxData[_]] && !FreeQ[c, DynamicBox] && FreeQ[c /. DynamicBox[___] -> Null, _String?(StringLength[StringTrim[#]] > 0 &)];

sectionText[c_] := Replace[c, {BoxData[InterpretationBox[Cell[s_String, ___], ___]] :> esc[s], x_ :> textHTML[x]}];

vocabCell[x_] := Replace[x, {
    Cell[t_, ___] :> textHTML[t],
    s_String :> esc[uni[s]],
    b_ :> With[{t = codeHTML[b]}, If[StringQ[t], "<code class=\"wl-inline\">" <> t <> "</code>", inlineImage[b, "InlineCode"]]]}];

(* ---------- notebooks ---------- *)

(* A notebook's page is its path under the content root: <root>/a/b/x.nb -> page "a/b/x". *)
PageInfo[file_String, root_String] := Module[{rel = relPath[file, root]},
   <|"page" -> StringDrop[rel, -3], "source" -> rel|>];
relPath[file_, root_] := StringRiffle[FileNameSplit[StringDrop[ExpandFileName[file], StringLength[ExpandFileName[root]] + 1]], "/"];

NotebookKey[file_] := sha[{fileSHA[file], renderer[], $Salt}];

(* True when the notebook's rendered page data is already cached (no kernel work needed). *)
NotebookCachedQ[file_String] := FileExistsQ[cachePath["notebooks", NotebookKey[file] <> ".json"]];

(* The notebook's own title: its WindowTitle, else its first title/chapter/section cell (cells
   only: an embedded stylesheet has "Section" cells of its own), else the file name. *)
nbTitle[nb_Notebook, file_] := Module[{wt = WindowTitle /. List @@ Rest[nb] /. WindowTitle -> None, t = None},
   If[StringQ[wt] && StringTrim[wt] =!= "", t = StringTrim@StringReplace[wt, "\n" -> " "]];
   If[t === None, t = FirstCase[First[nb], Cell[x_, "Title" | "Chapter" | "Section" | "SectionInline", ___] :>
       StringTrim@StringReplace[sectionText[x], "&amp;" -> "&"], None, Infinity]];
   If[!StringQ[t] || t === "", FileBaseName[file], t]];

Options[ExportNotebook] = {"Force" -> False, "Root" -> Automatic};
ExportNotebook[file_String, OptionsPattern[]] := Module[{root, info, key, path, nb, cells, blocks = {}, json, t0 = AbsoluteTime[]},
   root = Replace[OptionValue["Root"], Automatic -> DirectoryName[file]];
   info = PageInfo[file, root];
   key = NotebookKey[file];
   path = cachePath["notebooks", key <> ".json"];
   $Stats = <|"cells" -> 0, "cached" -> 0, "exported" -> 0, "failed" -> {}|>;
   (* A cached notebook is keyed by its bytes, not its place: re-attach the page it has here. *)
   If[!TrueQ[OptionValue["Force"]] && FileExistsQ[path] && AssociationQ[json = readJSON[path]],
    Return[Join[json, info, <|"notebook_cache" -> "hit", "stats" -> Join[json["stats"], <|"exported" -> 0|>]|>]]];
   nb = Get[file];
   If[Head[nb] =!= Notebook, Return[$Failed]];
   $SD = Replace[StyleDefinitions /. List @@ Rest[nb] /. StyleDefinitions -> "Default.nb", sd_Notebook :> sd];
   $SDHash = sha[$SD];
   cells = FlattenCells[First[nb]];
   Do[
    If[CellKind[styleOf[cell]] =!= "skip",
     With[{r = renderCell[cell, None]}, If[r["t"] =!= "skip", AppendTo[blocks, r]]]],
    {cell, cells}];
   (* A leading title cell repeats the page title (the site renders it from the frontmatter). *)
   With[{pos = FirstPosition[blocks, _?(#["t"] === "section" &), None, {1}]},
    If[pos =!= None && pos === {1}, blocks = Delete[blocks, pos]]];
   blocks = Replace[blocks, b_Association /; b["t"] === "section" :> Append[b, "t" -> "h2"], {1}];
   json = <|
      "exporter_version" -> $ExporterVersion,
      "renderer_hash" -> $RendererHash,
      "wolfram_version" -> $VersionNumber,
      "source_sha" -> fileSHA[file],
      "title" -> nbTitle[nb, file],
      "blocks" -> blocks,
      "stats" -> Join[$Stats, <|"seconds" -> N[Round[AbsoluteTime[] - t0, 1/10]]|>]|>;
   If[$Stats["failed"] === {}, WriteJSON[path, json]];
   Join[json, info, <|"notebook_cache" -> "miss"|>]];

(* ---------- symbols ---------- *)

ExportSymbols[] := Module[{path = cachePath["symbols", "symbols-" <> ToString[$VersionNumber] <> "-" <> $ExporterVersion <> ".json"], names, r},
   If[FileExistsQ[path] && ListQ[r = readJSON[path]], Return[r]];
   names = Select[Names["System`*"], StringMatchQ[#, LetterCharacter ~~ ___] && !StringStartsQ[#, "$"] || StringStartsQ[#, "$"] &];
   r = Map[Function[n, Module[{u = Quiet@ToExpression[n <> "::usage"], t},
        t = If[StringQ[u], Quiet@Check[First@FrontEndExecute[ExportPacket[Cell[u], "PlainText"]], u], ""];
        t = If[StringQ[t], StringTrim@First[StringSplit[t, "\n"], ""], ""];
        If[StringLength[t] > 160, t = StringTake[t, 157] <> "..."];
        <|"n" -> n, "u" -> t|>]], names];
   WriteJSON[path, r];
   r];

End[];
EndPackage[];
