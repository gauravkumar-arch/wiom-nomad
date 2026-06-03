const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Wiom_Travel_Desk_Portal.html'));
});

app.listen(PORT, () => {
  console.log(`Wiom Nomad running on port ${PORT}`);
});
