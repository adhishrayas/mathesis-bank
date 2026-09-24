// The stream's one control: narrow the posts to one author. Every post is in
// the generated page; the filter hides the others and updates the count.

import { qs, qsa } from "./dom";

export function mountPostsFilter(root: ParentNode = document): void {
  const select = qs<HTMLSelectElement>("select[data-filter='profile']", root);
  const count = qs<HTMLElement>("[data-field='posts.count']", root);
  const posts = qsa<HTMLElement>("article.mth-post[data-author-login]", root);
  if (!select || !count) return;
  const apply = (login: string): void => {
    let shown = 0;
    for (const post of posts) {
      const match = login === "" || post.getAttribute("data-author-login") === login;
      post.hidden = !match;
      if (match) shown += 1;
    }
    count.textContent = String(shown);
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
