# pi-protokoll

Eine [Pi](https://pi.dev)-Erweiterung für sehr lange Sitzungen mit lokalen Modellen: Das Modell
schreibt am Ende jedes Zugs ein kurzes Protokoll, und das Compacting baut daraus eine
begrenzte, gestufte Zusammenfassung, statt den ganzen Verlauf noch einmal lesen und
zusammenfassen zu lassen.

*English version: [README.md](README.md)*

## Warum

Pis eigenes Compacting schickt den alten Verlauf ans Modell und wartet, bis es eine
Zusammenfassung geschrieben hat. Mit einem lokalen Modell dauert das bei langen Sitzungen
Minuten, und die Zusammenfassung entsteht im Nachhinein aus einem überfüllten Kontext.

Hier passiert die teure Arbeit während der Arbeit: Jede abschließende Antwort endet mit einem
Protokollblock, geschrieben solange das Modell den Zug noch vollständig vor sich hat. Beim
Compacting liegt fast alles schon vor; Code setzt die Zusammenfassung zusammen, das Modell
schreibt nur noch eine kurze Übersicht fort.

Gemessen in einer Sitzung mit Qwen3.x an einem lokalen OpenAI-kompatiblen Server
(2× RTX 3090, 262k Kontextfenster):

- 22 Compactings über 118 Züge, jeweils etwa **213.000 → 35.000 Token in rund 30 s**
- die Wiederaufnahme der Sitzung liest etwa 36.000–44.000 Token
- jeder frühere Zug bleibt über Werkzeuge erreichbar

Praxisbeispiel: [64kdemo](https://github.com/sebion7125/64kdemo), eine prozedurale Waldlandschaft in C und OpenGL, mit Bildern, Kamerafahrt und Entstehungsgeschichte. Die ersten zehn Sitzungen liefen ohne die Erweiterung und endeten immer wieder in Kontextvergiftung; mit der Erweiterung blieb es ab dem Baumsystem eine einzige Sitzung, die oben gemessene.

## Ablauf

Ein *Zug* ist ein Arbeitslauf: deine Nachricht samt allen Werkzeugrunden bis zur
abschließenden Antwort. Nachrichten, die du schreibst, während das Modell noch arbeitet,
gehören zum laufenden Zug.

1. **Systemprompt.** Ein fester Abschnitt bittet das Modell, jede abschließende Antwort mit
   einem `<protocol>`-Block zu beenden: `result`, `decision`, `files`, `open`, `rule`, `revoke`,
   `index`, `tags`. Der Text ändert sich nie, damit der Präfix-Cache des Servers gültig bleibt.
2. **Antwort fertig.** Der Block wird aus der Antwort geschnitten und als Sitzungseintrag
   gespeichert, eingeklappt angezeigt (`▸ protocol turn 7: …`). Die Zugnummer vergibt die
   Erweiterung, nicht das Modell.
3. **Block fehlt.** Einmalige Nachforderung mit unverändertem Kontext plus kurzer Anweisung.
   Der Prompt beginnt wie der gerade gelaufene, ein Präfix-Cache liest also nur die neuen Token.
   Gespeichert wird nur der Block, nicht der Austausch. Ignoriert das Modell die Nachforderung, wird der Block
   sofort aus dem Transkript des Zugs geschrieben.
4. **Zug abgebrochen** (Esc, Fehler, Ausgabelimit). Bevor deine nächste Nachricht rausgeht,
   wird das Protokoll des abgebrochenen Zugs geschrieben: was erledigt ist, was offen bleibt.
   Werkzeugaufrufe aus Gewohnheit werden mit „Werkzeuge nicht verfügbar“ beantwortet, nicht
   ausgeführt. Klappt das nicht, folgt ein zweiter Versuch aus dem Transkript des Zugs.
5. **Compacting.** Pi löst wie gewohnt aus. Die Zusammenfassung hat Stufen mit harten Grenzen:

   | Stufe | Inhalt | Grenze |
   |---|---|---|
   | vollständig | die letzten Züge im Original | `keepRecentTurns`, höchstens `keepRecentPercent` % des Fensters |
   | Detail | die nächstälteren Züge: **deine Nachricht im Wortlaut** + Protokoll; angeheftete Züge im vollen Text; Züge ohne Protokoll als gekürztes Transkript | `detailMaxTokens` |
   | Stand | alles davor | `statusMaxTokens` |

   Der **Stand** besteht aus
   - einem **Index**, einer Zeile pro älterem Zug: der `index`-Zeile, die das Modell mit diesem
     Zug geschrieben hat. Code setzt ihn bei jedem Compacting neu aus den gespeicherten
     Protokollen zusammen, er kann also nicht driften. Passt er nicht mehr, werden die ältesten
     Züge zu Bereichszeilen aus ihren `tags` zusammengelegt
     (`[T1–T20] Blattpalette (T14, T16); DEMO_LEAFPAL (T14); Impostor-Atlas (T18–T19)`);
   - den geltenden **Vorgaben** (`rule` abzüglich `revoke`), den **offenen Punkten** und den
     **geänderten Dateien**, von Code aus den Protokollen übernommen;
   - einer **Zustandsbeschreibung**, dem einzigen Teil, den das Modell neu schreibt: Es bekommt
     die bisherige Beschreibung und die Protokolle der Züge, die gerade aus der Detailstufe
     fallen. Große Rückstände gehen in Teilen zu je `foldChunkTokens`.

   Ein **Prüflauf** lässt das Modell Vorgaben und offene Punkte aufräumen. Es kann nur per
   Nummer auswählen (`RULES: R1, R4`), also nichts umformulieren oder erfinden.

   Scheitert etwas, oder würde der Kontext nicht klein genug, gibt die Erweiterung ab und Pi
   kompaktiert auf seine Art. Der Chat blockiert nie.

6. **Nachschlagen** für das Modell:
   - `protocol_read("12, 40-44")` liefert die gespeicherten Protokolle samt deiner Nachricht,
   - `protocol_search(query)` findet Züge über Stichwörter (Tags zählen doppelt),
   - `protocol_turn(n)` liefert das Originaltranskript eines Zugs.

Während des Compactings und der Nachträge zeigt ein Widget über dem Eingabefeld den
Fortschritt. Danach zeigt es die neue Kontextgröße, bis zur nächsten Nachricht, weil Pi den
Chat nach dem Compacting neu zeichnet.

Jedes Compacting speichert zusätzlich einen eigenen Status-Eintrag (`protokoll-compact`): wie
es ausgegangen ist, die Gesamtzeit, die Zeit jedes Schritts und die Meldungszeilen des Ablaufs. Die Dauer ist damit auch lange nach dem Widget noch lesbar – in der Konsole und überall,
wo Session-Einträge dargestellt werden, zum Beispiel im Browser. `/protokoll export` listet die
Zeit jedes Compactings.

Während ein Durchlauf läuft, wird jeder Schritt zusätzlich über Pi's gemeinsamen Extensions-Bus
(Kanal `pi-protokoll:progress`, siehe `ProgressEvent` in `src/core.ts`) gemeldet, damit eine andere
Extension die laufenden Schritte live zeigen kann. Jede Meldung trägt den ganzen Durchlauf: pro
Schritt der Zustand, die eigene Zeit, wie viele Zeichen das Modell schon geschrieben hat und ob es
denkt oder schreibt – derselbe Status, den das Widget in der Konsole zeigt. Diese Zeilen werden nie
in der Session abgelegt – der Status-Eintrag pro Durchlauf bleibt das Protokoll.

## Installation

```bash
pi install git:github.com/sebion7125/pi-protokoll
```

oder aus einem lokalen Ordner:

```bash
pi install ./pi-protokoll
```

Pi neu starten (oder `/reload`), dann `/protokoll status`.

Konfiguration ist optional: `protokoll.example.json` nach `~/.pi/agent/protokoll.json`
kopieren und anpassen; pro Projekt überschreibt `<projekt>/.pi/protokoll.json`.

**Umstieg von der manuellen Installation** (`~/.pi/agent/extensions/protokoll/`): diesen Ordner
löschen, sonst lädt die Erweiterung doppelt. `protokoll.json` und alle Sitzungsdaten bleiben.

## Voraussetzungen und Geltungsbereich

- Pi ≥ 1.1. Im Alltag mit 1.1.0 benutzt; mit 1.4.0 typgeprüft, getestet und durchgängig mit Platzhalter-Modell ausgeführt.
- Gebaut und getestet für **lokale Modelle hinter einem OpenAI-kompatiblen Server** (Qwen3.x).
  Die Denkstufe der eigenen Anfragen wird direkt in die Anfrage geschrieben
  (`reasoning_effort`, `chat_template_kwargs.enable_thinking`); das wirkt nur bei solchen Servern.
- Andere Anbieter und Modelle sind **ungetestet**.

## Befehle

| Befehl | Wirkung |
|---|---|
| `/protokoll` oder `/protokoll status` | Zustand, Züge, Protokolle, angeheftete Züge, Abdeckung des Stands, Zahl der Compactings |
| `/protokoll show` | Vorschau der Zusammenfassung (ohne Modellaufruf) |
| `/protokoll export [datei]` | dasselbe als Markdown-Datei, mit Diagnoseteil: wirksame Konfiguration, alle Compactings, gespeicherter Stand mit geprüften Vorgaben, Tabelle aller Züge, alle Protokolle vollständig |
| `/protokoll pin N` / `unpin N` | Zug N beim Compacting im vollen Text behalten |
| `/protokoll on` / `off` | für diese Sitzung ein- oder ausschalten |
| `/protokoll reload` | `protokoll.json` neu einlesen |
| `/protokoll rebuild` | beim nächsten Compacting den Stand aus allen Protokollen neu aufbauen statt fortschreiben |
| `/protokoll repair` | ältere Sitzung auf den aktuellen Stand bringen: fehlende Protokolle aus dem Transkript, fehlende `index`/`tags` nachtragen (8 Züge pro Anfrage), danach Compacting mit Neuaufbau. Ersetzt nie, was das Modell selbst geschrieben hat; ein erneuter Aufruf setzt fort |

Die deutschen Befehlsnamen früherer Versionen (`zeigen`, `anheften`, `lösen`, `an`, `aus`,
`neu-laden`, `stand-neu`, `heilen`) funktionieren weiter.

## Konfiguration

Alle Schlüssel mit Standardwerten und Bedeutung stehen in der Tabelle der
[englischen README](README.md#configuration); die Werte in `protokoll.example.json` sind die
Standardwerte.

## Entwicklung

```bash
npm install
npm run check   # Typprüfung, Lint, Tests
npm run e2e     # echtes Pi aus node_modules + Platzhalter-Modell: Installation, neun Züge, Compacting
```

## Bekannte Grenzen

- Das Modell muss den Block schreiben. Qwen3.x vergisst ihn bei etwa der Hälfte der langen
  Züge mit vielen Werkzeugaufrufen; die Nachforderung behebt das in wenigen Sekunden.
- `/compact <Anweisung>` wird noch nicht an die Zustandsbeschreibung weitergegeben.
- Die Zustandsbeschreibung ist der einzige vom Modell neu geschriebene Teil und kann driften;
  Index, Listen und gespeicherte Protokolle nicht. `/protokoll rebuild` baut sie neu auf.

## Lizenz

MIT
