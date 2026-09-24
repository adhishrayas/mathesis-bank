// The stream's one control: narrow the posts to one author. Every post is in
// the generated page; the filter hides the others.

import { qs, qsa } from "./dom";

export function mountPostsFilter(root: ParentNode = document): void {
  const select = qs<HTMLSelectElement>("select[data-filter='profile']", root);
  const posts = qsa<HTMLElement>("article.mth-post[data-author-login]", root);
  if (!select) return;
  const apply = (login: string): void => {
    for (const post of posts) {
      post.hidden = !(login === "" || post.getAttribute("data-author-login") === login);
    }
    const url = new URL(window.location.href);
    if (login === "") url.searchParams.delete("profile");
    else url.searchParams.set("profile", login);
    window.history.replaceState(null, "", url.toString());
  };
  select.addEventListener("change", () => apply(select.value));
  qs<HTMLButtonElement>("button[data-filter-clear='profile']", root)?.addEventListener("click", () => {
    select.value = "";
    apply("");
  });
  const initial = new URLSearchParams(window.location.search).get("profile") ?? "";
  if (initial !== "") {
    select.value = initial;
    apply(select.value);
  }
}
