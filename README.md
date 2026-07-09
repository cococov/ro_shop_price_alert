# RO Shop Price Alert

Herramienta confirgurable que alerta precios de ítems en el mercado del juego Ragnarok Online.

## Historial de precios

Cada chequeo guarda un punto por ítem en `price-history.json` con timestamp, servidor, tipo de tienda, cantidad de listings y estadísticas `min`, `q1`, `median`, `q3`, `max` y `avg`.

Comandos interactivos:

```text
/history <item> max line
/history <item> day whisker
/history <item> session line
```

`max` muestra todo el historial guardado, `day` muestra las últimas 24 horas y `session` muestra los chequeos hechos desde que se inició el CLI. `line` muestra la evolución de `min`, `q1`, `median`, `q3` y `max` como líneas compactas. `whisker` imprime cada chequeo como un box/whisker escalado.

El archivo puede cambiarse al iniciar:

```sh
node index.js --history-file ./mi-historial.json
```
