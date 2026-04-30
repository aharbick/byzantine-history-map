## Per-episode extraction schema

Each `data/episodes/epNN.json` file:

```json
{
  "episode": 2,
  "title": "Diocletian",
  "people": [Person],
  "places": [Place],
  "events": [Event]
}
```

### Person
```json
{
  "id": "diocletian",
  "name": "Diocletian",
  "alt_names": ["Gaius Aurelius Valerius Diocletianus"],
  "role": "Roman Emperor",
  "birth_year": 244,
  "death_year": 311,
  "reign_start": 284,
  "reign_end": 305,
  "summary": "Born of humble Illyrian origins, rose through the army to become emperor in 284. Restructured the empire into the Tetrarchy...",
  "wikipedia_url": "https://en.wikipedia.org/wiki/Diocletian",
  "portrait_url": null,
  "transcript_lines": [[15, 80], [120, 145]],
  "related": [
    {"type": "person", "id": "maximian"},
    {"type": "place", "id": "nicomedia"},
    {"type": "event", "id": "tetrarchy-established"}
  ]
}
```

Years: integers. Negative for BCE. `null` if unknown.

### Place
```json
{
  "id": "nicomedia",
  "name": "Nicomedia",
  "modern_name": "İzmit",
  "modern_country": "Turkey",
  "lat": 40.7656,
  "lng": 29.9408,
  "first_year": 284,
  "summary": "Diocletian's eastern capital...",
  "wikipedia_url": "https://en.wikipedia.org/wiki/Nicomedia",
  "image_url": null,
  "transcript_lines": [[60, 75]],
  "related": []
}
```

### Event
```json
{
  "id": "tetrarchy-established",
  "name": "Establishment of the Tetrarchy",
  "year": 293,
  "end_year": null,
  "category": "political",
  "summary": "Diocletian formally divides imperial authority among four rulers...",
  "wikipedia_url": "https://en.wikipedia.org/wiki/Tetrarchy",
  "image_url": null,
  "location_id": "nicomedia",
  "transcript_lines": [[90, 110]],
  "related": [
    {"type": "person", "id": "diocletian"},
    {"type": "person", "id": "maximian"}
  ]
}
```

Categories: `battle`, `political`, `religious`, `cultural`, `economic`, `natural`, `dynastic`.

### IDs
kebab-case, stable across episodes. `constantine-the-great`, `battle-of-milvian-bridge`, `hagia-sophia`.
