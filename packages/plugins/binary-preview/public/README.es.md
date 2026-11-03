# Vista previa de binarios

Las colecciones suelen guardar archivos dentro de los documentos como valores binarios: avatares, recibos escaneados, miniaturas, PDF pequeños. Documentos muestra un valor así como `Binary(…)`, lo que no dice nada de lo que es. La vista previa de binarios indica qué contiene al apuntarlo y muestra las imágenes, dibujadas a partir de sus propios bytes. NoSQLBooster ofrece lo mismo como su «Binary Image Preview Tooltip».

## Dónde aparece

- **Valores de celda:** al apuntar a un valor binario en Documentos, indica qué contiene (`Imagen PNG · 320 × 200 · 24 KB`, `Documento PDF · 1,2 MB`, `Archivo ZIP`, `Audio MP3`, `Imagen HEIC`, `Vídeo QuickTime`) o, para cualquier otra cosa, su subtipo y su longitud. La aplicación envía al plugin solo los primeros 2 KB del valor, nunca el valor completo.
- **Pestaña Imágenes:** las imágenes almacenadas en los documentos de la colección (PNG, JPEG, GIF, WebP, AVIF, BMP y SVG), dentro del filtro de Documentos, de 12 en 12. Un clic muestra una en grande; **Abrir documento** abre su documento en la aplicación.
- **Mostrar imágenes** (una acción de documento): las imágenes de ese documento.

## Cómo lee

La pestaña primero lee 50 documentos para averiguar qué campos contienen imágenes (10 si esos 50 juntos superan el límite de mensaje de 1 MB de la aplicación y, después, de uno en uno); luego lee solo esos campos y `_id`, página a página en el orden de `_id`, pasando por `_id` de todo tipo. Una página que supera el límite se lee documento a documento; un documento demasiado grande incluso solo se cuenta, y la pestaña indica cuántos hay que abrir en Documentos. Una imagen grande mantiene el teclado en ella hasta que se cierra (Escape o **Cerrar**), y el foco vuelve a su miniatura.

Las imágenes se dibujan a partir de los propios bytes del valor como direcciones `data:`; la página del plugin no puede cargar nada más, y un SVG mostrado como imagen no ejecuta ningún script. Los UUID nunca se toman por archivos.

## Permisos

- **Leer documentos:** para encontrar y mostrar las imágenes, con tus permisos y con tus campos ocultos sin mostrarse.
