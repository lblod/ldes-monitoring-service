import bodyParser from "body-parser";
import { app } from "mu";
import { run } from "./main";
import { register } from "./metrics";
run();
app.use(
  bodyParser.json({
    limit: '50mb',
    type: function (req) {
      return /^application\/json/.test(req.get('content-type'));
    },
  }),
);

app.get("/metrics", async function (_req, res) {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});
