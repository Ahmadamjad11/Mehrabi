import { createElement } from "react";

type OsmMapFrameProps = {
  html: string;
};

export default function OsmMapFrame({ html }: OsmMapFrameProps) {
  return createElement("iframe", {
    title: "OpenStreetMap prayer places",
    srcDoc: html,
    sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox",
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
