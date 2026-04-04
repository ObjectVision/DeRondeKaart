- specification of style is generalized for each of the following three file formats: geoarrow/parquet + MVT + COG
- style specification should follow geostyler syntax
- style specification can make use of geostyler syntax
- see for example a MVT style below, where Class is a field of the features in the dataset:

{
  "name": "",
  "rules": [
    {
      "name": "minder dan 1%",
      "filter": ["==", "Class", 1],
      "symbolizers": [
        {
          "kind": "Fill",
          "color": "#4275b5",
          "outlineColor": "black",
          "outlineWidth": 0,
          "outlineOpacity": 0
        }
      ]
    },
    {
      "name": "1,0 - 1,5%",
      "filter": ["==", "Class", 2],
      "symbolizers": [
        {
          "kind": "Fill",
          "color": "#849ebd",
          "outlineColor": "black",
          "outlineWidth": 0,
          "outlineOpacity": 1
        }
      ]
    },
  ]
}

- legend for map A and map B reflects for each layer the referred classes above
- clicking a class in the legend should toggle visibility of the layer 