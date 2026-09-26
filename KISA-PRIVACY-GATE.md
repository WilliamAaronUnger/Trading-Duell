# KiSA – „Local Privacy Gate“: Recherche & Architekturempfehlung

Stand: September 2026. *Hinweis: Dieses Dokument betrifft KiSA, nicht Trading Duell; es liegt nur auf diesem Arbeitszweig.*

Alle Laufzeit- und RAM-Angaben mit „≈“ sind **Schätzwerte** aus Modellgröße und typischen CPU-Durchsätzen (ONNX Runtime / llama.cpp). Sie müssen mit dem in Abschnitt 6 beschriebenen Benchmark auf der tatsächlichen Zielhardware gemessen werden.

---

## 0. Kurzfassung (Empfehlung)

1. **Kein kleines generatives LLM als primärer Detektor.** Ein 1–4B-LLM ist auf CPU zu langsam für das Umschreiben ganzer Dokumente (Minuten pro Stellungnahme), liefert keine kalibrierten Konfidenzen, lässt beim Umschreiben unbemerkt Namen stehen, halluziniert und ist über den Dokumenttext per Prompt-Injection angreifbar.
2. **Empfohlen wird eine hybride, auf Recall ausgelegte Ensemble-Pipeline:**
   Regex/Validatoren + Gazetteers (Namenslisten, lokales Straßen- und Flurstücksverzeichnis) + zwei spezialisierte PII-Encoder-Modelle (GLiNER-PII-Familie und OpenAI Privacy Filter bzw. dessen mehrsprachige Feinabstimmung) + ein **selbst feinabgestimmter kleiner Satzklassifikator für sensible Kategorien** (Gesundheit, Familie, Wirtschaftslage, Art.-9-Kategorien, Quasi-Identifikatoren) + deutsche Fachlexika.
   Optional kommt ein kleines LLM (≈1,7–4B, Q4) **nur als Schiedsrichter** hinzu, für die wenigen Sätze im Unsicherheitsband, mit eng begrenzter Ausgabe (Ja/Nein bzw. JSON über eine Grammatik).
3. **Die Transformation erfolgt deterministisch und nach Regeln**, nicht per freiem LLM-Umschreiben: typisierte Platzhalter mit lokaler Zuordnung, dazu eine **Abstraktion mit Merkmalserhalt**. Beispiel: Aus „Multiple Sklerose → Gehbehinderung“ wird die Kategorie „Mobilitätseinschränkung“; aus der Flurstücknummer wird `[FLURSTÜCK_3]` plus lokal berechnete Lagemerkmale.
4. **Doppelte Absicherung:** Nach der Transformation prüft ein unabhängiger **Leak-Scan** den Ausgabetext erneut, und zwar mit dem Ensemble und zusätzlich per exaktem bzw. unscharfem String-Abgleich gegen alle im Original gefundenen Identifikatoren. Das Ergebnis ist ein Ampelurteil: GRÜN (Cloud frei), GELB (lokale menschliche Prüfung), ROT (nur lokal verarbeiten).
5. **Harte Architekturgrenze:** Nur ein separater Cloud-Dispatcher hat Netzzugriff. Er akzeptiert ausschließlich Nutzlasten, die das Gate signiert hat (Prinzip „Datendiode“). Damit kann das Gate nicht umgangen werden.
6. **Gesamtaufwand auf einem Büro-PC** (4–8 Kerne, 16 GB RAM, keine GPU): ≈ 1–4 s pro typischer Stellungnahme ohne LLM-Stufe, ≈ 2–4 GB RAM. Da das Gate als Pipeline parallel zum Cloud-Versand läuft (Streaming), bleibt der Geschwindigkeitsvorteil des Fast Mode weitgehend erhalten.
7. **Grenzen:** Das Ergebnis ist Pseudonymisierung bzw. Datenminimierung, **keine Anonymisierung**. Die übertragenen Texte bleiben rechtlich personenbezogene Daten (EDPB Guidelines 01/2025). Das Gate ist eine technisch-organisatorische Maßnahme (Art. 25/32 DSGVO) und ersetzt weder Auftragsverarbeitungsvertrag noch Datenschutz-Folgenabschätzung noch die Prüfung der Rechtsgrundlage.

---

## 1. Technische Ansätze und aktuelle Modelle/Frameworks

### 1.1 Überblick der Verfahrensklassen

| Klasse | Stärken | Schwächen | Rolle im Gate |
|---|---|---|---|
| **Regex + Validatoren** (Prüfsummen, libphonenumber) | deterministisch, ~100 % Recall bei strukturierten Daten (E-Mail, IBAN, Telefon, PLZ, Steuer-ID, Kfz-Kennzeichen, Flurstück-/Grundbuch-Formate), µs-schnell | keine Semantik | Pflichtbaustein |
| **Gazetteers / Wörterbücher** (Vor-/Nachnamen, lokales Straßenverzeichnis aus ALKIS/OSM, Gemarkungen; Allowlists für Behörden/TÖB/Planbegriffe) | hoher Recall bei lokal bekannten Entitäten, erklärbar | Mehrdeutigkeit („Vogel“, „Bauer“, „Wolf“) | Pflichtbaustein, Kandidaten + Kontextregeln |
| **Klassische NER** (spaCy `de_core_news_lg`, Flair German) | schnell, CPU-freundlich | nur PER/LOC/ORG/MISC, mäßiger Recall bei Briefköpfen/OCR-Text | zusätzliche Stimme im Ensemble |
| **Spezialisierte PII-Encoder** (GLiNER-PII, OpenAI Privacy Filter, deren Feinabstimmungen) | kontextbewusst, CPU-tauglich, feine Kategorien, Konfidenzen | kaum Art.-9-Kategorien (Gesundheit usw.), Deutsch z. T. schwächer | Kern der PII-Erkennung |
| **Feinabgestimmter Satzklassifikator** (deutsches Encoder-Modell, 100–200M) | erkennt *semantische* Sensibilität (Gesundheit, Familie …), kalibrierbar, schnell | braucht Trainingsdaten (synthetisch + lokal annotiert) | Kern der Art.-9-/Kontext-Erkennung |
| **Kleines generatives LLM** (1–4B, quantisiert) | Weltwissen, erkennt Umschreibungen/Euphemismen | langsam auf CPU, schlecht kalibriert, Auslassungen beim Umschreiben, Prompt-Injection | optionaler Schiedsrichter für Grenzfälle |

### 1.2 Konkrete Open-Source-Bausteine

- **Microsoft Presidio** (MIT): Orchestrierungs-Framework mit AnalyzerEngine (Recognizer-Registry, Kontextverstärkung, Deny-/Allowlists), AnonymizerEngine (Operatoren: replace/mask/hash/custom) und `presidio-research` für die Evaluation. Es lässt sich mit spaCy-, Transformers- und GLiNER-Recognizern kombinieren. **Out of the box auf Deutsch schwach**: In unabhängigen Benchmarks schneidet ein unkonfiguriertes Presidio bei kontextabhängiger PII sehr schlecht ab (PIIBench: F1 ≈ 0,14). Presidio eignet sich deshalb als *Gerüst*, nicht als fertige Lösung. [Presidio-Transformers](https://microsoft.github.io/presidio/samples/python/transformers_recognizer/), [Customizing](https://microsoft.github.io/presidio/samples/python/customizing_presidio_analyzer/), [PIIBench](https://arxiv.org/pdf/2604.15776)
- **OpenAI Privacy Filter** (Apache 2.0, April 2026): Token-Klassifikator mit ≈1,5B Parametern gesamt, aber nur ≈50M aktiv (Mixture of Experts). Er läuft lokal auf Laptop bzw. im Browser, verarbeitet Kontexte bis 128k Tokens und kennt 8 Kategorien (Namen, Adressen, E-Mail, Telefon, URL, Datum, Kontonummern, Secrets). Trainiert wurde er primär auf Englisch. Laut Modellkarte ist er „kein Anonymisierungsgarantie-Werkzeug“, und der Recall sinkt bei weit entfernten Kontexthinweisen. [OpenAI](https://openai.com/index/introducing-openai-privacy-filter/), [GitHub](https://github.com/openai/privacy-filter), [Modellkarte](https://cdn.openai.com/pdf/c66281ed-b638-456a-8ce1-97e9f5264a90/OpenAI-Privacy-Filter-Model-Card.pdf), [Einordnung für EU](https://innfactory.ai/en/blog/openai-privacy-filter-pii-detection-apache-2/), [Kritik für Produktion](https://www.datamasque.com/blog/why-privacy-filter-isnt-enough-for-production-data-masking)
  - **OpenMed `privacy-filter-multilingual(-v2)`**: Feinabstimmung auf 54 PII-Klassen in 16 Sprachen, Deutsch gehört zu den stärker unterstützten. Für KiSA ist das der interessantere Kandidat. [HF v2](https://huggingface.co/OpenMed/privacy-filter-multilingual-v2), [Cross-lingual-Evaluation](https://arxiv.org/pdf/2608.02616)
- **GLiNER-Familie** (Zero-Shot-NER, Labels frei im Prompt, CPU-tauglich, ONNX-exportierbar):
  - `urchade/gliner_multi_pii-v1` (mehrsprachig inkl. Deutsch), `E3-JSI/gliner-multi-pii-domains-v1`, `nvidia/gliner-PII`, Sammlung `freinold/gliner-pii-models` (6 bzw. 9 Sprachen inkl. Deutsch). [Sammlung](https://huggingface.co/collections/freinold/gliner-pii-models), [nvidia](https://huggingface.co/nvidia/gliner-PII)
  - **GLiNER2-PII** (Fastino, Mai 2026, ≈300M): 42 Entitätstypen in 7 Kategorien, mehrsprachig. Unter den GLiNER-Detektoren hat es den besten Recall (≈0,72 im Mittel auf dem SPY-Benchmark, Rechts- und Medizindomäne). Laut Autoren übertrifft es den OpenAI Privacy Filter. [Paper](https://arxiv.org/abs/2605.09973), [Blog](https://fastino.ai/blog/gliner2-pii-open-source-privacy-filtering-with-pii-detection), [HF](https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi)
  - Vorteil: Zusätzliche Labels wie „medizinische Diagnose“, „Behinderung“ oder „Familienangehöriger“ lassen sich ohne Neutraining abfragen. Der Recall dafür ist ohne Feinabstimmung aber unzuverlässig.
- **Deutsche Medizin-NER** als Gesundheits-Detektoren: GERNERMED/GPTNERMED (Medikation, Dosierung, Diagnose), `HUMADEX/german_medical_ner`, medBERT.de. In einer Studie zur De-Identifikation deutscher klinischer Dokumente erreichte ein feinabgestimmtes gELECTRA einen Makro-F1 von 0,95. [GERNERMED](https://www.sciencedirect.com/science/article/pii/S2665963821000944), [GPTNERMED](https://github.com/frankkramer-lab/GPTNERMED), [De-ID-Pipeline](https://pubmed.ncbi.nlm.nih.gov/39778706)
- **Deutsche Encoder-Basismodelle** für den eigenen Sensibilitäts-Klassifikator: gBERT/gELECTRA (base ≈110M), ModernGBERT (≈134M, lange Kontexte), EuroBERT, XLM-R-base, multilingual-e5-small. Alle lassen sich per int8-ONNX gut auf der CPU betreiben.
- **Lexika:** ICD-10-GM und Alpha-ID-SE (BfArM, deutsche Diagnose-Synonyme), Medikamentenlisten, Begriffe rund um Behinderung und Pflege („GdB“, „Merkzeichen aG“, „Pflegegrad“, „Rollator“, „Dialyse“).
- **Kleine LLMs** (Schiedsrichter): Qwen3-1.7B/4B, Gemma 3 1B/4B, Llama 3.2 3B, SmolLM3-3B, LFM2 (CPU-optimiert) bzw. deren Nachfolger. Betrieb über llama.cpp oder Ollama mit GGUF Q4_K_M und Grammatik-beschränkter Ausgabe. Das Deutsch der Qwen- und Gemma-Modelle ist in dieser Größenklasse am brauchbarsten. Die Auswahl sollte über den Benchmark aus Abschnitt 6 erfolgen, nicht nach Datenblatt.
- **Weitere:** LLM Guard (Anonymize-Scanner auf Presidio-Basis, englischlastig), MAPA (EU-Projekt zur Anonymisierung für öffentliche Verwaltungen, mehrsprachig; älter, aber domänennah).

**Wichtig:** Keines der fertigen PII-Modelle deckt die für KiSA schwierigsten Fälle zuverlässig ab: Gesundheit, Familienverhältnisse, indirekte Identifizierbarkeit und Flurstücke. Diese Lücke muss KiSA selbst schließen, und zwar mit Regeln, Lexika und einem feinabgestimmten Klassifikator.

---

## 2. Realistische Hardware-Anforderungen (Windows-Büro-PC, keine GPU)

Referenzgerät: Intel Core i5/i7 der 8.–13. Generation bzw. Ryzen 5, 4–8 Kerne, 16 GB RAM, Windows 10/11, SSD.

| Baustein | Größe | RAM (≈) | Laufzeit pro Stellungnahme¹ (≈) | Anmerkung |
|---|---|---|---|---|
| Regex, Validatoren, Gazetteers | – | < 100 MB | < 50 ms | |
| spaCy `de_core_news_lg` | CNN | ≈ 0,6 GB | < 0,2 s | |
| GLiNER-PII (mdeberta-base-Klasse, ≈200–300M), ONNX int8 | | ≈ 0,4–1,2 GB | ≈ 0,3–1,5 s | Chunks à 384–512 Tokens |
| OpenAI Privacy Filter / OpenMed-Variante (1,5B gesamt, 50M aktiv) | MoE | ≈ 1,5–3 GB (int8/bf16) | ≈ 0,3–2 s | rechenarm, aber speicherintensiv |
| Eigener Satzklassifikator (110–150M), ONNX int8 | | ≈ 0,2–0,5 GB | ≈ 0,1–0,5 s | alle Sätze |
| **Summe Hybrid ohne LLM** | | **≈ 2–4 GB** | **≈ 1–4 s** | parallelisierbar über Prozesse |
| Optional: LLM-Schiedsrichter 1,7B Q4 | GGUF | ≈ 1,3–2 GB | ≈ 1–3 s pro Grenzfall-Satz | nur für ≈ 5–15 % der Sätze |
| Optional: LLM-Schiedsrichter 4B Q4 | GGUF | ≈ 2,5–3,5 GB | ≈ 3–8 s pro Grenzfall-Satz | |
| *Zum Vergleich: vollständiges Umschreiben durch 4B-LLM* | | ≈ 3 GB | **≈ 1–4 min** | CPU-Generierung ≈ 5–20 Token/s → **nicht praktikabel** |

¹ Typische Stellungnahme mit 1–2 Seiten, ≈ 1.000–2.000 Tokens, ohne OCR. OCR (Tesseract, docTR) für gescannte Seiten kostet zusätzlich ≈ 1–5 s pro Seite und ist oft der eigentliche Engpass.

Zur Einordnung der LLM-Zahlen: Veröffentlichte llama.cpp-Messungen zeigen für 3B-Modelle in Q4_K_M auf 4 CPU-Threads je nach Hardware ≈ 8–23 Token/s bei der Generierung ([Beispiel](https://singhajit.com/llm-inference-speed-comparison/), [llama.cpp-Diskussion](https://github.com/ggml-org/llama.cpp/discussions/21112)). Das Einlesen des Prompts ist schneller, fällt bei Dokumentlänge aber ebenfalls ins Gewicht.

**Konsequenzen:**
- Mit **8 GB RAM** das Privacy-Filter-Modell *oder* das LLM weglassen. Die Kernpipeline aus Regeln, GLiNER und Klassifikator passt in ≈ 1,5 GB.
- **Durchsatz:** Mit 2–3 Worker-Prozessen auf 4–8 Kernen sind ≈ 1–3 Stellungnahmen pro Sekunde realistisch. Das Gate arbeitet als **Streaming-Pipeline**: Freigegebene Dokumente gehen sofort in die Cloud, während der Rest noch geprüft wird. So addiert sich die Gate-Latenz nicht zur Cloud-Latenz.
- **Auslieferung unter Windows:** eingebettetes Python oder kompilierter Dienst mit ONNX Runtime (CPU, int8) und llama.cpp (optional). Alle Modelle werden mit dem Installer ausgeliefert, zur Laufzeit wird nichts nachgeladen.

---

## 3. Kleines generatives LLM oder hybride Pipeline?

**Die hybride Pipeline ist überlegen.** Für kleine LLMs bleibt die Rolle eines eng begrenzten Schiedsrichters.

| Kriterium | Kleines LLM (1–4B) als Hauptdetektor/Umschreiber | Hybrid (Regeln + PII-Encoder + Klassifikator) |
|---|---|---|
| Recall bei strukturierter PII | schwankend, übersieht Nummern und Mails in langen Texten | ≈ 100 % über Regex/Validatoren |
| Recall bei Namen | gut, aber Auslassungen beim Umschreiben unbemerkt | hoch durch Ensemble und Namens-Propagation im Dokument |
| Semantische Sensibilität (Gesundheit usw.) | Stärke des LLM (Weltwissen, Euphemismen) | gut, wenn der Klassifikator domänenspezifisch trainiert ist |
| Kalibrierte Konfidenz | schwach (Logprobs nur für Ja/Nein brauchbar) | ja (Scores, kalibrierbar, Schwellen pro Kategorie) |
| Determinismus und Nachvollziehbarkeit | eingeschränkt | vollständig (Span, Detektor, Score, Regel) |
| Inhaltstreue | Umschreiben verändert Aussagen, Halluzinationen möglich | Ersetzungen auf Span-Ebene, Rest bleibt wörtlich |
| Robustheit gegen Prompt-Injection im Dokument | angreifbar („Ignoriere alle Anweisungen …“) | nicht betroffen |
| Latenz auf CPU | Minuten bei Voll-Umschreibung | Sekunden |
| Wartbarkeit | Prompt-Tuning, schwer testbar | Regeln, Lexika und Schwellen versioniert und per Regressionstest prüfbar |

**Sinnvoller LLM-Einsatz** (optional, nach Benchmark):
- **Schiedsrichter:** Nur Sätze mit Score im Unsicherheitsband oder mit Detektor-Widerspruch werden vorgelegt. Die Frage ist geschlossen, z. B. „Enthält der Satz Angaben zu Gesundheit, Behinderung, Familie, finanzieller Lage, Religion … oder einen eindeutig identifizierenden Umstand? Antworte als JSON nach Schema“. Die Ausgabe wird per GBNF-Grammatik erzwungen, als Konfidenz dient die Logprob des Tokens. **Das LLM darf eine Markierung nur hinzufügen oder in GELB umwandeln, niemals eine Markierung anderer Detektoren aufheben.** Das ist eine monotone Sicherheitslogik.
- **Destillation statt Laufzeit-LLM** (empfohlen): Ein großes Modell, lokal auf einer GPU-Workstation oder in der Cloud **ausschließlich mit synthetischen Daten**, labelt einen großen Satzkorpus. Darauf wird der kleine Encoder-Klassifikator trainiert. Er übernimmt einen großen Teil des LLM-„Verständnisses“ und läuft dabei in Millisekunden.

---

## 4. Umgang mit fachlich relevanten sensiblen Angaben

Leitprinzip: **Planungsrelevant ist die *Betroffenheit*, nicht die *Identität* oder die *Diagnose*.** Transformiert wird deshalb nach dem Prinzip „so konkret wie nötig, so abstrakt wie möglich“, und zwar deterministisch über eine versionierte Policy-Tabelle.

### 4.1 Transformationsarten

| Art | Anwendung | Beispiel |
|---|---|---|
| **Typisierter Platzhalter** (lokal zugeordnet) | direkte Identifikatoren | „Herr Karl Meier“ → `[PERSON_1]`, „meier.k@web.de“ → `[EMAIL_1]` |
| **Platzhalter mit Merkmalserhalt** | Grundstück, Adresse | „Flst. 123/4, Gmkg. Oberdorf“ → `[FLURSTÜCK_1: im Geltungsbereich; Wohnnutzung; angrenzend an geplantes GE]` (lokal per ALKIS/GIS oder Straßenverzeichnis berechnet) |
| **Funktionale Abstraktion** | Gesundheit, Behinderung | „Multiple Sklerose … Gehbehinderung“ → „eine gesundheitlich bedingte Mobilitätseinschränkung“ |
| **Generalisierung** | Familie, Alter, Wirtschaftslage | „alleinerziehend mit drei Kindern (4, 7, 9)“ → „Haushalt mit minderjährigen Kindern“; „mit 87 Jahren“ → „hochbetagte Person“; „Bürgergeld“ → „eingeschränkte wirtschaftliche Leistungsfähigkeit“ |
| **Vergröberung** | Daten | Geburtsdatum → entfernen; persönliche Ereignisdaten → Jahr. Verfahrensfristen bleiben erhalten. |
| **Entfernung + Hinweis** | nicht planungsrelevante sensible Angaben | Religion, sexuelle Orientierung, Parteizugehörigkeit ohne Planungsbezug → `[ENTFERNT: persönliche Angabe ohne Planungsbezug]` |
| **Ausschluss** (ROT) | wenn Abstraktion den Kern zerstören würde oder Unsicherheit hoch ist | lokale Verarbeitung mit dem lokalen LLM |

### 4.2 Gesundheits-Abstraktion konkret

Eine lokale Mapping-Tabelle ordnet **Diagnose bzw. Symptom einer funktionalen Planungskategorie** zu. Aufgebaut wird sie aus Alpha-ID/ICD-10-GM-Gruppen und von Hand kuratiert:

| Funktionale Kategorie (Cloud sieht nur diese) | Beispiele (bleiben lokal) | Planungsbezug |
|---|---|---|
| Mobilitätseinschränkung | MS, Querschnitt, Arthrose, Rollstuhl, Rollator, Merkzeichen aG/G | Barrierefreiheit, Wege, Stellplätze, ÖPNV |
| Seh- oder Höreinschränkung | Blindheit, Makuladegeneration, Schwerhörigkeit | Leitsysteme, Querungen |
| Lärm- oder Umweltempfindlichkeit | Migräne, Tinnitus, Asthma, COPD, Allergien | Immissionen, Staub |
| Psychische Belastung | Depression, Angststörung, PTBS | Lärm, Verschattung, Sicherheitsgefühl |
| Pflege- oder Betreuungsbedarf im Haushalt | Demenz, Pflegegrad, Dialyse | Erreichbarkeit, Zufahrt für Dienste |
| Gesundheitliche Einschränkung (unspezifisch) | alles ohne Mapping | → **GELB** (menschliche Prüfung) |

Die Transformation passiert auf **Span-Ebene**. Beispiel:
„Aufgrund ~~meiner Multiplen Sklerose und der daraus resultierenden Gehbehinderung~~ **einer gesundheitlich bedingten Mobilitätseinschränkung** bin ich auf den barrierefreien Zugang zur Bushaltestelle angewiesen.“

Der Rest des Satzes bleibt wörtlich, die Ich-Form ist ohne Identität unproblematisch. Soll ein Satz in die Form „Die betroffene Person gibt … an“ gebracht werden, geschieht das über Satzvorlagen (Templates) und nicht über freie Generierung. Nutzt man ein LLM zur Glättung, muss dessen Ausgabe **erneut vollständig durch den Leak-Scan**. Zusätzlich wird geprüft, ob die Kategorie noch vorhanden ist und ob keine neuen Entitäten hinzugekommen sind.

### 4.3 Grundstücks- und Ortsbezüge

- **Straßennamen des Plangebiets ohne Hausnummer** sind meist fachlich nötig und selten identifizierend. Sie stehen auf einer Allowlist, die aus dem lokalen Straßenverzeichnis erzeugt wird. **Straße + Hausnummer**, Flurstück, Grundbuchblatt und Kfz-Kennzeichen gelten immer als Identifikator.
- Die fachlich relevanten Lagemerkmale werden **lokal** berechnet und als Attribute an den Platzhalter gehängt: im oder außerhalb des Geltungsbereichs, Abstandsklasse zu geplanten Nutzungen, Himmelsrichtung, Nutzungsart. Die Cloud-Analyse bleibt so fachlich aussagekräftig, ohne das Grundstück zu kennen.
- Bei **„Wir als Anlieger“** und ähnlichen Formulierungen bleibt die Betroffenheit erhalten, die Adresse wird ersetzt.

### 4.4 Konsistente Pseudonyme

- Die Platzhalter-IDs werden per **HMAC mit einem lokalen, verfahrensbezogenen Schlüssel** gebildet. Dieselbe Person bzw. dasselbe Flurstück erhält im ganzen Verfahren dieselbe ID. Das ist wichtig für Sammeleinwendungen, Mehrfach-Einwender und Abwägungsgruppen. Ohne Schlüssel lässt sich nichts zurückrechnen.
- Die Zuordnungstabelle (ID ↔ Original ↔ Dokument) liegt verschlüsselt lokal. Cloud-Ergebnisse mit Platzhaltern werden **lokal** rückaufgelöst und angezeigt.
- **Platzhalter statt realistischer Ersatznamen:** Mit Platzhaltern wird jeder Rest-Leak im Ausgabetext sofort sichtbar und prüfbar. Realistische Ersatznamen würden echte Restnamen tarnen.

---

## 5. Automatische Eskalation zur menschlichen Prüfung

### 5.1 Ampellogik (konservativer Startwert)

**ROT (nur lokale Verarbeitung):**
- OCR-Konfidenz unter dem Schwellwert, Handschrift oder unbekannte Sprache bzw. Dokumentstruktur
- Angaben zu Minderjährigen **in Kombination mit** Gesundheit oder Familie
- sexuelles Leben, strafrechtliche Angaben oder mehrere Art.-9-Kategorien in einem Dokument
- Transformation würde den Kernsachverhalt entfernen (z. B. mehr als X % des Textes betroffen)
- Leak-Scan findet auch nach der zweiten Runde noch etwas

**GELB (lokale Prüfung vor Freigabe):**
- beliebiger Detektor-Score im **Unsicherheitsband** [t_low, t_high] einer Kategorie
- **Widerspruch der Detektoren** (ein Modell meldet PII, andere nicht, bei mittlerem Score)
- Gesundheitsangabe ohne Eintrag in der Mapping-Tabelle
- Muster für Quasi-Identifikatoren: „als einziger/einzige …“, „Inhaber/Betreiber des …“, „Vorsitzender des …“, Beruf + Ort, exakte Altersangaben, Anzahl der Kinder, Vorfälle mit Datum
- **Unbekannte Eigennamen:** Tokens, die spaCy als PROPN taggt oder die nicht im deutschen Wörterbuch (Hunspell) und nicht auf der Allowlist stehen, aber von keinem Detektor gemeldet wurden. Im Deutschen ist das wegen der Großschreibung von Substantiven ein besonders wichtiges Signal.
- unklassifizierte lange Zahlen oder Zeichenketten
- **Einschwingphase:** In den ersten Wochen werden 100 % der Dokumente mit Art.-9-Treffern geprüft. Stichproben ersetzen die Vollprüfung erst, wenn der Benchmark den Ziel-Recall belegt.

**GRÜN (automatische Cloud-Freigabe):**
- nur Treffer über t_high, alle ersetzt, Leak-Scan sauber, keine GELB-Trigger

### 5.2 Kalibrierung

- Die Schwellen werden **pro Kategorie** auf einem Validierungsset so gesetzt, dass der Ziel-Recall erreicht wird. Die Prüfquote ist dabei die Kostengröße, die optimiert wird, nicht F1.
- Die Detektoren sind **monoton verknüpft**: Die Vereinigungsmenge aller Treffer wird maskiert. Kein Detektor darf Treffer eines anderen aufheben. Einzige Ausnahme sind explizite Allowlist-Regeln, die versioniert und testabgedeckt sind.
- **Namens-Propagation:** Wird ein Name an einer Stelle erkannt, etwa im Briefkopf, werden *alle* Vorkommen im Dokument maskiert. Dazu gehören Flexionen („Meiers“), Teilformen und die E-Mail-Lokalteile.

### 5.3 Prüfoberfläche (lokal)

- Links steht das Original, rechts der Cloud-Text. Spans sind farbig nach Kategorie markiert, mit Begründung (Detektor, Score, Regel).
- Aktionen: freigeben, Span hinzufügen oder entfernen, Abstraktionsstufe wählen, „nur lokal verarbeiten“.
- **Jede Entscheidung wird lokal protokolliert** und fließt in Lexika, Allowlists und das Nachtraining des Klassifikators ein (Active Learning). So sinkt die Prüfquote mit der Zeit.
- Revisionsfestes Audit-Log: Gate-Version, Modell-Hashes, Befunde, Hash der gesendeten Nutzlast und prüfende Person.

---

## 6. Benchmark-Design (Recall/False-Negative-zentriert)

### 6.1 Korpus

1. **Echte historische Stellungnahmen** aus abgeschlossenen Verfahren, lokal annotiert. Dafür ist eine interne Rechtsgrundlage und Freigabe durch die/den Datenschutzbeauftragte:n nötig. Die Stellungnahmen verlassen nie den Rechner.
2. **Synthetische Stellungnahmen** mit Vorlagen und gezielt injizierten Fällen. Da sie keine echten Daten enthalten, dürfen sie mit einem großen LLM erzeugt werden.
3. **Adversarial-/Härtefall-Set:**
   - Namen, die auch Substantive sind (Vogel, Bauer, Koch, Wolf, Winter), kleingeschriebene Namen, Namen nur im Grußblock oder in der E-Mail-Adresse
   - OCR-Rauschen, Silbentrennung am Zeilenende, Tabellen, Briefköpfe, Unterschriftszeilen
   - Flurstück-Schreibweisen („Fl.-Nr.“, „Flst.“, „FlSt 123/4“, „Gemarkung“, „Flur 3“), Grundbuch
   - implizite Gesundheit: „seit meinem Schlaganfall“, „nach der Chemo“, „als Dialysepatientin dreimal pro Woche“, „unser Sohn mit Down-Syndrom“, „wegen meiner Lunge“
   - Familie: „meine pflegebedürftige Mutter wohnt bei uns“, „seit der Scheidung“
   - Quasi-Identifikatoren: „als einzige Hebamme im Ort“, „Betreiber der Bäckerei am Marktplatz“, „der Reiterhof direkt neben dem Plangebiet“
   - Art. 9 indirekt: Religion („auf dem Weg zur Moschee“), Orientierung („mein Mann und ich“ bei männlichem Verfasser), Gewerkschaft, Partei
   - Mehrfach-Einwender, Sammeleinwendungen mit Unterschriftenlisten
   - **Prompt-Injection-Texte** im Dokument (für die LLM-Stufe)
   - Behördliche TÖB-Stellungnahmen (Negativbeispiele: Behördennamen sollen erhalten bleiben)

### 6.2 Annotation

- Leitfaden mit Kategorien: direkte Identifikatoren, Ortsbezug, Art. 9, Familie, Wirtschaftslage, Quasi-Identifikator. Zu jeder Kategorie gehören Schweregrad und erwartete Transformation.
- Doppelannotation eines Teilsets mit Messung der Übereinstimmung (Cohen's/Fleiss' κ). Abweichungen werden adjudiziert.

### 6.3 Metriken

| Metrik | Definition | Zielwert (Vorschlag) |
|---|---|---|
| **Leak-Rate end-to-end** (Haupt-KPI) | Anteil annotierter sensibler Einheiten, von denen *irgendein identifizierender Bestandteil* im **Ausgabetext** landet. Gemessen wird auf dem transformierten Text, nicht an der Detektorausgabe. | direkte Identifikatoren ≤ 0,5 %, Art. 9 ≤ 1 % |
| **Dokument-Leak-Rate** | Anteil der GRÜN-freigegebenen Dokumente mit ≥ 1 Leak | ≤ 1 % |
| Recall pro Kategorie (lenient/strict Span) | klassisch, zur Diagnose | – |
| Schweregrad-gewichteter Recall | Art. 9 und Minderjährige hoch gewichtet | – |
| **Prüfquote** | Anteil GELB/ROT | beobachten, sinkend |
| Precision / Übermaskierung | Anteil fälschlich maskierter Tokens | sekundär |
| **Nutzen-Erhalt** | Übereinstimmung der Analyseergebnisse (Themen, Belange, Abwägungskategorien) auf Original vs. bereinigtem Text, lokal mit dem lokalen LLM gemessen | ≥ 95 % Übereinstimmung |
| Latenz p50/p95, RAM-Spitze | auf Referenzhardware | p95 ≤ 5 s pro Dokument |

### 6.4 Statistik

- Für seltene Kategorien werden **obere Konfidenzgrenzen** (Clopper-Pearson) angegeben, keine Punktwerte. Nach der „Rule of Three“ braucht man ≈ **300 Positivfälle ohne einen einzigen Fehler**, um eine FN-Rate < 1 % mit 95 % Konfidenz zu belegen. Das Härtefall-Set muss entsprechend groß sein.
- Jeder False Negative bekommt eine Ursachenanalyse (Fehler-Taxonomie) und wird zum Regressionstest.
- Der Benchmark läuft bei jeder Änderung an Modellen, Lexika, Regeln oder Schwellen automatisch mit (CI). Eine Freigabe gibt es nur, wenn keine Kategorie beim Recall schlechter wird.
- Das Benchmark-Set bleibt getrennt von Trainings- und Kalibrierdaten. Ein Teil wird zurückgehalten und nur zur Release-Abnahme verwendet.

---

## 7. Grenzen technischer Bereinigung

1. **Pseudonymisierung ≠ Anonymisierung.** Solange KiSA die Zuordnung hält, bleiben die übertragenen Texte personenbezogene Daten (EDPB Guidelines 01/2025, Art. 4 Nr. 5 DSGVO). Daraus folgt: AV-Vertrag nach Art. 28, Prüfung von Drittlandtransfers, Rechtsgrundlage, und wegen Art.-9-Daten sehr wahrscheinlich eine **DSFA** nach Art. 35. [EDPB](https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2025/guidelines-012025-pseudonymisation_en)
2. **Freitext ist fast nie sicher anonymisierbar.** Lokale Einzigartigkeit („der einzige Landwirt am Nordrand“), die Kombination mehrerer harmloser Merkmale, Schreibstil und Querbezüge zu öffentlichen Unterlagen (Abwägungstabellen, Presse, Ratsprotokolle) können re-identifizieren. In kleinen Gemeinden ist das Risiko strukturell hoch.
3. **ML-Detektoren haben keine Garantie.** Der gemessene Recall gilt nur für die Verteilung des Benchmarks. Neue Formate, OCR-Fehler und Dialekt senken ihn im Feld. Aktuelle Untersuchungen zeigen deutliche Robustheitslücken von PII-Detektoren bei Störungen und Umformulierungen ([Mind the Gap](https://arxiv.org/pdf/2609.03464)).
4. **Abstraktion ist Umdeutung.** „Mobilitätseinschränkung“ statt „MS“ kann fachliche Nuancen kosten. Deshalb muss die Abwägung **immer auf das lokale Original** zurückgreifen. Das Cloud-Ergebnis ist nur ein Assistenzbefund.
5. **Anhänge, Bilder, Unterschriften, Lagepläne und Fotos** werden nicht bereinigt. Sie gehen grundsätzlich nicht in die Cloud, übertragen wird nur extrahierter und geprüfter Text.
6. **Menschliche Prüfer machen Fehler**, vor allem bei hoher Prüfquote (Ermüdung). Die Prüfquote ist deshalb selbst ein Sicherheitsparameter.
7. **Cloud-Anbieterrisiko:** Auch minimierte Texte werden beim Anbieter verarbeitet und unter Umständen protokolliert. Zero-Retention-Vereinbarungen und die EU-Region sollten vertraglich gesichert werden.

---

## 8. Architekturvorschlag für KiSA

```
                    ┌──────────────── LOKAL (kein Netz) ────────────────────────────────┐
 Original-PDF/Mail  │ 1 Ingest      2 Segmentierung   3 Detektor-Ensemble (Vereinigung)  │
 ─────────────────► │ Text/OCR,  ─► Sätze, Offsets, ─► a Regex+Validatoren              │
                    │ Layout:        Briefkopf/Gruß-    b Gazetteers (Namen, Straßen,     │
                    │ Briefkopf,     block, Unter-        Flurstücke, Allowlists)         │
                    │ Signatur,      schriftenliste     c spaCy/Flair NER                 │
                    │ Anhänge→lokal                     d GLiNER(2)-PII                   │
                    │                                   e Privacy Filter (multilingual)   │
                    │                                   f Sensibilitäts-Klassifikator      │
                    │                                     + Fachlexika (Gesundheit …)     │
                    │                                   g Quasi-ID-Heuristiken,           │
                    │                                     unbekannte Eigennamen           │
                    │                                   h (opt.) LLM-Schiedsrichter        │
                    │                                     nur Unsicherheitsband            │
                    │        ▼                                                             │
                    │ 4 Fusion & Risiko ─► 5 Policy-Engine (YAML, versioniert)            │
                    │   Span-Merge,          Platzhalter (HMAC) · Merkmalserhalt (GIS)    │
                    │   Namens-Propagation   Funktionale Abstraktion · Generalisierung    │
                    │        ▼                                                             │
                    │ 6 Leak-Scan (unabhängig): Ensemble erneut + String-/Fuzzy-Abgleich  │
                    │   gegen alle Original-Identifikatoren des Dokuments                  │
                    │        ▼                                                             │
                    │ 7 Ampel: GRÜN ─────────────┐  GELB ─► 8 Prüf-UI ─┐  ROT ─► lokales  │
                    │                            ▼                     ▼        LLM         │
                    │                  Freigabe-Queue (Gate signiert Nutzlast + Audit)    │
                    │  Zuordnungstabelle (verschlüsselt) ◄───────── 10 Rückauflösung      │
                    └────────────────────────────┬──────────────────────▲────────────────┘
                                                 ▼                      │
                              9 Cloud-Dispatcher (einziger Prozess mit Netz;
                                prüft Gate-Signatur, sendet nur bereinigten Text)
                                                 ▼                      │
                                        Cloud-LLM (Fast Mode) ──────────┘ Ergebnisse mit Platzhaltern
```

### 8.1 Komponenten-Details

- **Prozesstrennung („Datendiode“):** Das Gate läuft als eigener Dienst ohne Netzrecht (Windows-Firewall-Regel pro Programm). Der Dispatcher hat Netz, aber keinen Zugriff auf Originale. Er nimmt nur Nutzlasten an, die das Gate per HMAC signiert hat und die ein Urteil GRÜN oder „freigegeben durch Person X“ tragen. Ein Code-Pfad, der das Gate umgeht, existiert damit nicht.
- **Konfiguration:** Policy-Tabellen (Kategorie → Transformation → Ampel), Schwellen, Lexika und Allowlists liegen versioniert als YAML oder JSON. Jede Änderung löst den Benchmark aus.
- **Lokale Fachdaten:** Das Straßenverzeichnis und die Flurstücksgeometrien des Verfahrens (ALKIS/XPlanung, Geltungsbereich) dienen dazu, Adressen und Flurstücke lokal zu erkennen **und** die Lagemerkmale zu berechnen.
- **Technik-Stack (Vorschlag):** Python 3.12, Presidio als Orchestrierung (eigene Recognizer), ONNX Runtime CPU für GLiNER, Privacy Filter und Klassifikator (int8), spaCy, libphonenumber, llama.cpp (optional). Verpackt als Windows-Dienst, der mit KiSA über lokales IPC (Named Pipe bzw. localhost mit Token) kommuniziert.
- **Degradationsmodus:** Fällt ein Detektor aus (Modell nicht ladbar, RAM knapp), bleibt nichts automatisch grün. Das Gate schaltet dann auf GELB bzw. ROT (fail closed).

### 8.2 Umsetzungsfahrplan

| Phase | Inhalt | Ergebnis |
|---|---|---|
| **P0 – Benchmark zuerst** (3–4 Wo.) | Annotationsleitfaden, Korpus (echt lokal + synthetisch + Härtefälle), Metrik-Skripte | messbare Basis |
| **P1 – Deterministischer Kern** (3–4 Wo.) | Ingest/OCR, Segmentierung, Regex/Validatoren, Gazetteers, Namens-Propagation, Platzhalter/HMAC, Leak-Scan, Ampel, Datendiode | direkte Identifikatoren abgedeckt |
| **P2 – Modell-Ensemble** (2–3 Wo.) | GLiNER-PII vs. GLiNER2-PII vs. Privacy Filter (OpenMed) auf eigenem Benchmark vergleichen, die besten 1–2 übernehmen, Schwellen kalibrieren | Namen und Adressen robust |
| **P3 – Semantische Sensibilität** (4–6 Wo.) | Lexika (Alpha-ID/ICD, Pflege/Behinderung), Satzklassifikator per Destillation trainieren, Mapping-Tabelle für funktionale Abstraktion, Quasi-ID-Heuristiken | Gesundheit, Familie, Quasi-IDs |
| **P4 – Prüf-UI & Betrieb** (3 Wo.) | Review-Oberfläche, Audit-Log, Active-Learning-Schleife, Windows-Installer | Pilotbetrieb mit 100 % Art.-9-Prüfung |
| **P5 – Optional LLM-Schiedsrichter** (2 Wo.) | Qwen3-/Gemma-Kleinmodell per llama.cpp nur für das Unsicherheitsband. Einsatz nur, wenn der Benchmark weniger Leaks oder eine geringere Prüfquote ohne Recall-Verlust zeigt. | messbar begründete Entscheidung |

**Entscheidungsregel für P5:** Das LLM wird nur aufgenommen, wenn es auf dem Härtefall-Set die Leak-Rate senkt oder bei gleicher Leak-Rate die Prüfquote um mindestens ≈ 20 % reduziert und die p95-Latenz im Budget bleibt.

---

## Quellen

- OpenAI Privacy Filter: [Ankündigung](https://openai.com/index/introducing-openai-privacy-filter/), [GitHub](https://github.com/openai/privacy-filter), [HF](https://huggingface.co/openai/privacy-filter), [Modellkarte](https://cdn.openai.com/pdf/c66281ed-b638-456a-8ce1-97e9f5264a90/OpenAI-Privacy-Filter-Model-Card.pdf), [Help Net Security](https://www.helpnetsecurity.com/2026/04/23/openai-privacy-filter-personally-identifiable-information/), [innFactory](https://innfactory.ai/en/blog/openai-privacy-filter-pii-detection-apache-2/), [DataMasque-Kritik](https://www.datamasque.com/blog/why-privacy-filter-isnt-enough-for-production-data-masking), [Cross-lingual-Evaluation](https://arxiv.org/pdf/2608.02616)
- OpenMed: [privacy-filter-multilingual-v2](https://huggingface.co/OpenMed/privacy-filter-multilingual-v2), [privacy-filter-multilingual](https://huggingface.co/OpenMed/privacy-filter-multilingual)
- GLiNER: [GLiNER2-PII Paper](https://arxiv.org/abs/2605.09973), [Fastino-Blog](https://fastino.ai/blog/gliner2-pii-open-source-privacy-filtering-with-pii-detection), [HF GLiNER2-PII](https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi), [gliner_multi_pii-v1](https://huggingface.co/urchade/gliner_multi_pii-v1), [nvidia/gliner-PII](https://huggingface.co/nvidia/gliner-PII), [freinold-Sammlung](https://huggingface.co/collections/freinold/gliner-pii-models), [E3-JSI](https://huggingface.co/E3-JSI/gliner-multi-pii-domains-v1)
- Presidio: [Transformers-Recognizer](https://microsoft.github.io/presidio/samples/python/transformers_recognizer/), [Anpassung](https://microsoft.github.io/presidio/samples/python/customizing_presidio_analyzer/), [presidio-research](https://github.com/microsoft/presidio-research)
- Benchmarks/Robustheit: [PIIBench](https://arxiv.org/pdf/2604.15776), [Mind the Gap](https://arxiv.org/pdf/2609.03464), [Presidio vs. Privacy Filter](https://github.com/eelisLF/pii-benchmark), [SLM-PII-Substitution](https://arxiv.org/pdf/2605.13538)
- Deutsche Medizin-NER/De-ID: [Transformer-De-ID-Pipeline](https://pubmed.ncbi.nlm.nih.gov/39778706), [GERNERMED](https://www.sciencedirect.com/science/article/pii/S2665963821000944), [GPTNERMED](https://github.com/frankkramer-lab/GPTNERMED), [HUMADEX](https://huggingface.co/HUMADEX/german_medical_ner), [JAMIA Open](https://academic.oup.com/jamiaopen/article/5/4/ooac087/6827559)
- LLM-CPU-Leistung: [Vergleich](https://singhajit.com/llm-inference-speed-comparison/), [llama.cpp #21112](https://github.com/ggml-org/llama.cpp/discussions/21112)
- Recht: [EDPB Guidelines 01/2025](https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2025/guidelines-012025-pseudonymisation_en), [PDF](https://www.edpb.europa.eu/system/files/2025-01/edpb_guidelines_202501_pseudonymisation_en.pdf)
