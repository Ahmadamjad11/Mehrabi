import { createElement } from "react";

type OsmMapFrameProps = {
  html: string;
};

export default function OsmMapFrame({ html }: OsmMapFrameProps) {
  // Generated map data is escaped in the HTML; same-origin is needed for OSM's Referer policy, and Leaflet is SRI-pinned.
  return createElement("iframe", {
    title: "OpenStreetMap prayer places",
    srcDoc: html,
    sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    referrerPolicy: "strict-origin",
    style: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      width: "100%",
      height: "100%",
      border: 0,
    },
  });
}
